/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { fluxStores } from "@webpack";
import {
    ContextMenuApi,
    createRoot,
    ExpressionPickerStore,
    Menu,
    React,
    SelectedChannelStore,
    useCallback,
    useEffect,
    useMemo,
    useState
} from "@webpack/common";
import type { Root } from "react-dom/client";

const enum GridSize {
    Compact = "compact",
    Comfortable = "comfortable",
    Large = "large"
}

const enum GifSort {
    Recent = "recent",
    Name = "name",
    Wide = "wide"
}

const settings = definePluginSettings({
    sendOnSelect: {
        type: OptionType.BOOLEAN,
        description: "Send the GIF as a message when you click it. If off, the URL is only inserted into the chat box.",
        default: false
    },
    closeOnSelect: {
        type: OptionType.BOOLEAN,
        description: "Close the expression picker after selecting a GIF.",
        default: true
    },
    gridSize: {
        type: OptionType.SELECT,
        description: "Default GIF grid density for the Categories tab.",
        options: [
            { label: "Compact", value: GridSize.Compact },
            { label: "Comfortable", value: GridSize.Comfortable, default: true },
            { label: "Large", value: GridSize.Large }
        ]
    }
});

interface Gif {
    format: number;
    src: string;
    width: number;
    height: number;
    order?: number;
    url: string;
}

const TAB_ID = "vc-gc-tab";
const PANEL_ID = "vc-gc-panel";
const STORE_KEY = "GifCategories_data_v1";
const UNCATEGORIZED = "__uncategorized__";
const ALL_FAVORITES = "__all__";
const INITIAL_GIF_RENDER_COUNT = 24;
const GIF_RENDER_BATCH_SIZE = 18;
const GIF_MEDIA_ROOT_MARGIN = "650px 0px";

interface CategoryData {
    order: string[];
    assignments: Record<string, string>;
}

let dataCache: CategoryData = { order: [], assignments: {} };
const listeners = new Set<() => void>();
const renderedGifCountCache = new Map<string, number>();
const mediaStateCache = new Map<string, "loaded" | "error">();

async function loadData() {
    const stored = await DataStore.get<CategoryData>(STORE_KEY);
    if (stored) dataCache = stored;
    notify();
}

async function saveData() {
    await DataStore.set(STORE_KEY, dataCache);
    notify();
}

function notify() {
    listeners.forEach(l => l());
}

function useCategoryData() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const l = () => setTick(t => t + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);
    return dataCache;
}

function lookupStore(name: string): any {
    return fluxStores.get(name) ?? null;
}

let cachedProtoStore: any = null;
function getProtoStore() {
    return (cachedProtoStore ||= lookupStore("UserSettingsProtoStore"));
}

let cachedGifStore: any = null;
function getGifStore() {
    if (cachedGifStore) return cachedGifStore;
    for (const name of ["GIFPickerStore", "GIFStore"]) {
        const s = lookupStore(name);
        if (s) return (cachedGifStore = s);
    }
    for (const s of fluxStores.values()) {
        if (s && typeof (s as any).getFavorites === "function") {
            return (cachedGifStore = s);
        }
    }
    return null;
}

function pushFav(out: Gif[], url: string, info: any) {
    if (!info || typeof info !== "object") return;
    if (!url) return;
    out.push({
        url,
        src: info.src ?? info.url ?? url,
        width: info.width ?? 0,
        height: info.height ?? 0,
        format: info.format ?? 0,
        order: info.order
    });
}

function normalizeFavorites(raw: any): Gif[] {
    if (raw == null) return [];
    const out: Gif[] = [];

    if (Array.isArray(raw)) {
        for (const item of raw) pushFav(out, item?.url, item);
    } else if (raw instanceof Map) {
        for (const [k, v] of raw) pushFav(out, k, v);
    } else if (typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) pushFav(out, k, v);
    }

    return out.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
}

function readProtoFavorites(proto: any): any {
    if (!proto) return null;
    const candidates: any[] = [];
    const fr = proto.frecencyWithoutFetchingLatest ?? proto.getFrecencyWithoutFetchingLatest?.();
    if (fr) {
        candidates.push(fr.favoriteGifs?.gifs, fr.favoriteGifs);
    }
    const { settings } = proto;
    if (settings) {
        candidates.push(settings.favoriteGifs?.gifs, settings.favoriteGifs);
    }
    if (typeof proto.getState === "function") {
        try {
            const state = proto.getState();
            const stateFr = state?.frecency?.favoriteGifs?.gifs ?? state?.frecency?.favoriteGifs;
            if (stateFr) candidates.push(stateFr);
        } catch { /* ignore */ }
    }
    for (const c of candidates) {
        if (c && (Array.isArray(c) || c instanceof Map || typeof c === "object")) {
            return c;
        }
    }
    return null;
}

function getFavorites(): Gif[] {
    // Prefer Discord's GIF picker store when it is available.
    try {
        const arr = getGifStore()?.getFavorites?.();
        const normalized = normalizeFavorites(arr);
        if (normalized.length) return normalized;
    } catch { /* ignore */ }

    try {
        const proto = getProtoStore();
        const raw = readProtoFavorites(proto);
        const normalized = normalizeFavorites(raw);
        if (normalized.length) return normalized;
    } catch { /* ignore */ }

    return [];
}

// Updated by the GIF picker patch when Discord passes favorites into the picker.
let capturedFavorites: Gif[] = [];
const favListeners = new Set<() => void>();

function notifyFavListeners() {
    favListeners.forEach(l => l());
}

export function captureFavorites(favs: any): any {
    if (Array.isArray(favs)) {
        const normalized = normalizeFavorites(favs);
        // Avoid re-rendering the panel when Discord sends the same favorites again.
        if (normalized.length !== capturedFavorites.length ||
            normalized.some((g, i) => g.url !== capturedFavorites[i]?.url)) {
            capturedFavorites = normalized;
            notifyFavListeners();
        }
    }
    return favs;
}

function useFavorites(): Gif[] {
    const initial = capturedFavorites.length ? capturedFavorites : getFavorites();
    const [favs, setFavs] = useState<Gif[]>(initial);
    useEffect(() => {
        const update = () => {
            setFavs(capturedFavorites.length ? capturedFavorites : getFavorites());
        };
        favListeners.add(update);
        const stores = [getGifStore(), getProtoStore()].filter(Boolean);
        for (const s of stores) s.addChangeListener?.(update);
        update();
        return () => {
            favListeners.delete(update);
            for (const s of stores) s.removeChangeListener?.(update);
        };
    }, []);
    return favs;
}

async function createCategory(name: string) {
    name = name.trim();
    if (!name || dataCache.order.includes(name)) return;
    dataCache = { ...dataCache, order: [...dataCache.order, name] };
    await saveData();
}

async function renameCategory(oldName: string, newName: string) {
    newName = newName.trim();
    if (!newName || newName === oldName || dataCache.order.includes(newName)) return;
    const order = dataCache.order.map(n => (n === oldName ? newName : n));
    const assignments: Record<string, string> = {};
    for (const [url, cat] of Object.entries(dataCache.assignments)) {
        assignments[url] = cat === oldName ? newName : cat;
    }
    dataCache = { order, assignments };
    await saveData();
}

async function deleteCategory(name: string) {
    const order = dataCache.order.filter(n => n !== name);
    const assignments: Record<string, string> = {};
    for (const [url, cat] of Object.entries(dataCache.assignments)) {
        if (cat !== name) assignments[url] = cat;
    }
    dataCache = { order, assignments };
    await saveData();
}

async function assignGif(url: string, category: string | null) {
    const assignments = { ...dataCache.assignments };
    if (category == null) delete assignments[url];
    else assignments[url] = category;
    dataCache = { ...dataCache, assignments };
    await saveData();
}

async function clearCategory(name: string) {
    const assignments = { ...dataCache.assignments };
    for (const [url, category] of Object.entries(assignments)) {
        if (category === name) delete assignments[url];
    }
    dataCache = { ...dataCache, assignments };
    await saveData();
}

async function exportCategoryData() {
    await copyText(JSON.stringify(dataCache, null, 2));
}

async function importCategoryData() {
    const text = await navigator.clipboard?.readText?.();
    if (!text) return;

    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch {
        return;
    }

    if (!Array.isArray(parsed?.order) || !parsed.assignments || typeof parsed.assignments !== "object") return;

    const order = [...dataCache.order];
    for (const name of parsed.order) {
        if (typeof name === "string" && name.trim() && !order.includes(name)) order.push(name);
    }

    const validCategories = new Set(order);
    const assignments = { ...dataCache.assignments };
    for (const [url, category] of Object.entries(parsed.assignments)) {
        if (typeof url === "string" && typeof category === "string" && validCategories.has(category)) {
            assignments[url] = category;
        }
    }

    dataCache = { order, assignments };
    await saveData();
}

function copyText(text: string) {
    return navigator.clipboard?.writeText(text);
}

function openGifUrl(url: string) {
    window.open(url, "_blank", "noopener,noreferrer");
}

function randomGif(gifs: Gif[]) {
    return gifs[Math.floor(Math.random() * gifs.length)];
}

function gifsInCategory(category: string, favorites: Gif[]): Gif[] {
    if (category === ALL_FAVORITES) return favorites;
    if (category === UNCATEGORIZED) {
        return favorites.filter(g => !dataCache.assignments[g.url]);
    }
    return favorites.filter(g => dataCache.assignments[g.url] === category);
}

function getGifListCacheKey(categoryName: string, query: string) {
    return `${categoryName}\n${query.trim().toLowerCase()}`;
}

function useProgressiveGifList(gifs: Gif[], cacheKey: string) {
    const observerRef = React.useRef<IntersectionObserver | null>(null);
    const [visibleCount, setVisibleCount] = useState(() =>
        Math.min(gifs.length, renderedGifCountCache.get(cacheKey) ?? INITIAL_GIF_RENDER_COUNT)
    );

    useEffect(() => {
        setVisibleCount(Math.min(gifs.length, renderedGifCountCache.get(cacheKey) ?? INITIAL_GIF_RENDER_COUNT));
    }, [cacheKey, gifs.length]);

    useEffect(() => {
        renderedGifCountCache.set(cacheKey, visibleCount);
    }, [cacheKey, visibleCount]);

    const loadMore = useCallback(() => {
        setVisibleCount(count => Math.min(gifs.length, count + GIF_RENDER_BATCH_SIZE));
    }, [gifs.length]);

    const sentinelRef = useCallback((element: HTMLDivElement | null) => {
        observerRef.current?.disconnect();
        observerRef.current = null;
        if (!element || visibleCount >= gifs.length) return;
        if (!("IntersectionObserver" in window)) {
            loadMore();
            return;
        }

        observerRef.current = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) loadMore();
        }, {
            root: element.closest(".vc-gc-content"),
            rootMargin: "250px 0px"
        });

        observerRef.current.observe(element);
    }, [gifs.length, loadMore, visibleCount]);

    useEffect(() => () => {
        observerRef.current?.disconnect();
    }, []);

    return {
        visibleGifs: gifs.slice(0, visibleCount),
        visibleCount,
        hasMore: visibleCount < gifs.length,
        sentinelRef
    };
}

function useNearViewport(rootMargin = GIF_MEDIA_ROOT_MARGIN) {
    const observerRef = React.useRef<IntersectionObserver | null>(null);
    const [isNearViewport, setNearViewport] = useState(false);

    const ref = useCallback((element: Element | null) => {
        observerRef.current?.disconnect();
        observerRef.current = null;
        if (!element || isNearViewport) return;
        if (!("IntersectionObserver" in window)) {
            setNearViewport(true);
            return;
        }

        observerRef.current = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) {
                setNearViewport(true);
                observerRef.current?.disconnect();
                observerRef.current = null;
            }
        }, {
            root: element.closest(".vc-gc-content"),
            rootMargin
        });

        observerRef.current.observe(element);
    }, [isNearViewport, rootMargin]);

    useEffect(() => () => {
        observerRef.current?.disconnect();
    }, []);

    return [
        ref,
        isNearViewport
    ] as const;
}

let observer: MutationObserver | undefined;
let activePanelRoot: Root | undefined;
let activePanelEl: HTMLElement | undefined;
let categoriesActive = false;
let activeNavList: HTMLElement | null = null;

const NAV_SELECTOR = "[aria-label='Expression Picker Categories']";

function findNavList(root: ParentNode = document): HTMLElement | null {
    return root.querySelector(NAV_SELECTOR);
}

function getInactiveClassName(navList: HTMLElement): string {
    const inactive = navList.querySelector<HTMLElement>("[aria-selected='false']");
    if (inactive) return inactive.className;
    const active = navList.querySelector<HTMLElement>("[aria-selected='true']");
    return active?.className ?? "";
}

function getActiveOnlyClasses(navList: HTMLElement): string[] {
    const active = navList.querySelector<HTMLElement>("[aria-selected='true']");
    const inactive = navList.querySelector<HTMLElement>("[aria-selected='false']");
    if (!active) return [];
    const inactiveSet = new Set((inactive?.className ?? "").split(/\s+/));
    return active.className.split(/\s+/).filter(c => c && !inactiveSet.has(c));
}

function injectTab(navList: HTMLElement) {
    const wired = (navList as any).__vcGcWired === true;

    // Discord can rebuild this list while the picker is open.
    if (!navList.querySelector(`#${TAB_ID}`)) {
        const inactiveClass = getInactiveClassName(navList);
        const tab = document.createElement("div");
        tab.id = TAB_ID;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", "false");
        tab.setAttribute("aria-label", "Categories");
        tab.setAttribute("tabindex", "0");
        tab.className = inactiveClass;
        tab.textContent = "Categories";
        navList.append(tab);
    }

    if (wired) return;
    (navList as any).__vcGcWired = true;

    // Delegate from the list so the handler survives tab re-renders.
    navList.addEventListener("click", e => {
        const target = (e.target as HTMLElement | null)?.closest?.("[role='tab']") as HTMLElement | null;
        if (!target || !navList.contains(target)) return;
        if (target.id === TAB_ID) {
            activateCategoriesTab(navList);
        } else if (categoriesActive) {
            deactivateCategoriesTab(navList);
        }
    }, true);

    navList.addEventListener("keydown", e => {
        const target = (e.target as HTMLElement | null)?.closest?.("[role='tab']") as HTMLElement | null;
        if (!target || target.id !== TAB_ID) return;
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activateCategoriesTab(navList);
        }
    }, true);
}

function markTabActive(navList: HTMLElement) {
    const tab = navList.querySelector<HTMLElement>(`#${TAB_ID}`);
    if (!tab) return;
    const activeExtras = getActiveOnlyClasses(navList);
    for (const child of Array.from(navList.children) as HTMLElement[]) {
        if (child === tab) {
            child.setAttribute("aria-selected", "true");
            if (activeExtras.length) child.classList.add(...activeExtras);
        } else {
            if (child.getAttribute("aria-selected") === "true") {
                child.setAttribute("aria-selected", "false");
                if (activeExtras.length) child.classList.remove(...activeExtras);
            }
        }
    }
}

function activateCategoriesTab(navList: HTMLElement) {
    activeNavList = navList;
    categoriesActive = true;
    markTabActive(navList);

    // Mount into the active picker panel so Discord's sizing still applies.
    const host = document.querySelector<HTMLElement>(
        "#gif-picker-tab-panel, #sticker-picker-tab-panel, #emoji-picker-tab-panel"
    );
    if (!host) return;

    if (getComputedStyle(host).position === "static") {
        host.style.position = "relative";
    }

    unmountActivePanel();
    activePanelEl = document.createElement("div");
    activePanelEl.id = PANEL_ID;
    activePanelEl.className = "vc-gc-panel";
    activePanelEl.setAttribute("role", "tabpanel");
    host.append(activePanelEl);

    activePanelRoot = createRoot(activePanelEl);
    activePanelRoot.render(<CategoriesPanel onSelectGif={handleGifSelected} />);
}

function handleGifSelected(gif: Gif) {
    const { sendOnSelect, closeOnSelect } = settings.store;

    if (sendOnSelect) {
        const channelId = SelectedChannelStore.getChannelId();
        if (channelId) sendMessage(channelId, { content: gif.url });
    } else {
        insertTextIntoChatInputBox(gif.url + " ");
    }

    if (closeOnSelect) {
        ExpressionPickerStore.closeExpressionPicker();
    }
}

function deactivateCategoriesTab(navList: HTMLElement) {
    categoriesActive = false;
    activeNavList = null;
    const tab = navList.querySelector<HTMLElement>(`#${TAB_ID}`);
    if (tab) {
        const activeExtras = getActiveOnlyClasses(navList);
        tab.setAttribute("aria-selected", "false");
        if (activeExtras.length) tab.classList.remove(...activeExtras);
    }
    unmountActivePanel();
}

function unmountActivePanel() {
    activePanelRoot?.unmount();
    activePanelRoot = undefined;
    activePanelEl?.remove();
    activePanelEl = undefined;
}

function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
        const navList = findNavList();
        if (!navList) {
            if (categoriesActive) {
                categoriesActive = false;
                activeNavList = null;
                unmountActivePanel();
            }
            return;
        }
        injectTab(navList);

        if (categoriesActive) {
            if (navList.querySelector<HTMLElement>(`#${TAB_ID}`)?.getAttribute("aria-selected") !== "true") {
                markTabActive(navList);
            }
            if (!document.getElementById(PANEL_ID)) {
                activateCategoriesTab(navList);
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const navList = findNavList();
    if (navList) injectTab(navList);
}

function stopObserver() {
    observer?.disconnect();
    observer = undefined;
    unmountActivePanel();
    document.querySelectorAll(`#${TAB_ID}`).forEach(el => el.remove());
}

function CategoriesPanel({ onSelectGif }: { onSelectGif(gif: Gif): void; }) {
    const data = useCategoryData();
    const favorites = useFavorites();
    const [view, setView] = useState<{ kind: "categories"; } | { kind: "category"; name: string; }>({ kind: "categories" });
    const [query, setQuery] = useState("");
    const [gridSize, setGridSize] = useState<GridSize>(() => settings.store.gridSize);
    const [sort, setSort] = useState<GifSort>(GifSort.Recent);

    const setGridPreset = useCallback((nextGridSize: GridSize) => {
        settings.store.gridSize = nextGridSize;
        setGridSize(nextGridSize);
    }, []);

    return (
        <div className={`vc-gc-panel-inner vc-gc-grid-${gridSize}`}>
            <CategoryHeader
                view={view}
                onBack={() => setView({ kind: "categories" })}
                onRenamed={next => setView({ kind: "category", name: next })}
                onDeleted={() => setView({ kind: "categories" })}
            />

            <div className="vc-gc-search">
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                    <path fill="currentColor" d="M10.5 4a6.5 6.5 0 0 1 5.17 10.44l3.45 3.44-1.24 1.24-3.44-3.45A6.5 6.5 0 1 1 10.5 4Zm0 1.75a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5Z" />
                </svg>
                <input
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.currentTarget.value)}
                    placeholder={view.kind === "categories" ? "Search categories…" : "Search GIFs…"}
                />
            </div>

            <PanelToolbar
                view={view}
                data={data}
                favorites={favorites}
                gridSize={gridSize}
                sort={sort}
                onGridSizeChange={setGridPreset}
                onSortChange={setSort}
            />

            <div className="vc-gc-content">
                {view.kind === "categories" ? (
                    <CategoriesView
                        data={data}
                        favorites={favorites}
                        query={query}
                        onOpenCategory={name => {
                            setQuery("");
                            setView({ kind: "category", name });
                        }}
                    />
                ) : (
                    <CategoryDetailView
                        categoryName={view.name}
                        favorites={favorites}
                        data={data}
                        query={query}
                        sort={sort}
                        onSelect={onSelectGif}
                    />
                )}
            </div>
        </div>
    );
}

function labelForCategory(name: string) {
    if (name === ALL_FAVORITES) return "All Favorites";
    if (name === UNCATEGORIZED) return "Uncategorized";
    return name;
}

// Icons ඞ

const BackIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
        <path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
    </svg>
);

const PencilIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z" />
    </svg>
);

const TrashIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z" />
    </svg>
);

const CheckIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
);

const XIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </svg>
);

const PlusIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
        <path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" />
    </svg>
);

const GridIcon = ({ columns }: { columns: number; }) => (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        {Array.from({ length: columns }).map((_, i) => {
            const width = (18 - (columns - 1) * 2) / columns;
            return <rect key={i} x={3 + i * (width + 2)} y="5" width={width} height="14" rx="1.5" fill="currentColor" />;
        })}
    </svg>
);

function categoryCount(favorites: Gif[], category: string) {
    return gifsInCategory(category, favorites).length;
}

function PanelToolbar({
    view,
    data,
    favorites,
    gridSize,
    sort,
    onGridSizeChange,
    onSortChange
}: {
    view: { kind: "categories"; } | { kind: "category"; name: string; };
    data: CategoryData;
    favorites: Gif[];
    gridSize: GridSize;
    sort: GifSort;
    onGridSizeChange(gridSize: GridSize): void;
    onSortChange(sort: GifSort): void;
}) {
    const uncategorizedCount = useMemo(
        () => favorites.filter(g => !data.assignments[g.url]).length,
        [data, favorites]
    );
    const currentCount = view.kind === "category"
        ? categoryCount(favorites, view.name)
        : data.order.length + 2;

    return (
        <div className="vc-gc-toolbar">
            <div className="vc-gc-stats" aria-live="polite">
                {view.kind === "category" ? (
                    <>
                        <strong>{currentCount}</strong>
                        <span>GIFs</span>
                    </>
                ) : (
                    <>
                        <strong>{favorites.length}</strong>
                        <span>favorites</span>
                        <span className="vc-gc-dot" />
                        <strong>{uncategorizedCount}</strong>
                        <span>uncategorized</span>
                    </>
                )}
            </div>

            {view.kind === "category" && (
                <select
                    className="vc-gc-select"
                    value={sort}
                    aria-label="Sort GIFs"
                    onChange={e => onSortChange(e.currentTarget.value as GifSort)}
                >
                    <option value={GifSort.Recent}>Recent</option>
                    <option value={GifSort.Name}>Name</option>
                    <option value={GifSort.Wide}>Wide first</option>
                </select>
            )}

            <div className="vc-gc-segment" aria-label="Grid size">
                <button
                    type="button"
                    className={gridSize === GridSize.Large ? "vc-gc-segment-active" : undefined}
                    aria-label="Large grid"
                    onClick={() => onGridSizeChange(GridSize.Large)}
                >
                    <GridIcon columns={1} />
                </button>
                <button
                    type="button"
                    className={gridSize === GridSize.Comfortable ? "vc-gc-segment-active" : undefined}
                    aria-label="Comfortable grid"
                    onClick={() => onGridSizeChange(GridSize.Comfortable)}
                >
                    <GridIcon columns={2} />
                </button>
                <button
                    type="button"
                    className={gridSize === GridSize.Compact ? "vc-gc-segment-active" : undefined}
                    aria-label="Compact grid"
                    onClick={() => onGridSizeChange(GridSize.Compact)}
                >
                    <GridIcon columns={3} />
                </button>
            </div>
        </div>
    );
}

function CategoryHeader({
    view,
    onBack,
    onRenamed,
    onDeleted
}: {
    view: { kind: "categories"; } | { kind: "category"; name: string; };
    onBack(): void;
    onRenamed(newName: string): void;
    onDeleted(): void;
}) {
    const [mode, setMode] = useState<"idle" | "rename" | "delete">("idle");
    const [draft, setDraft] = useState("");

    useEffect(() => {
        setMode("idle");
        setDraft("");
    }, [view.kind, view.kind === "category" ? view.name : null]);

    const isUserCategory =
        view.kind === "category" && view.name !== ALL_FAVORITES && view.name !== UNCATEGORIZED;

    const title = view.kind === "categories" ? "GIF Categories" : labelForCategory(view.name);

    const submitRename = async () => {
        if (view.kind !== "category") return;
        const next = draft.trim();
        if (!next || next === view.name) {
            setMode("idle");
            return;
        }
        await renameCategory(view.name, next);
        setMode("idle");
        onRenamed(next);
    };

    const confirmDelete = async () => {
        if (view.kind !== "category") return;
        await deleteCategory(view.name);
        setMode("idle");
        onDeleted();
    };

    return (
        <header className="vc-gc-header">
            {view.kind === "category" && (
                <button type="button" className="vc-gc-icon-btn" aria-label="Back" onClick={onBack}>
                    <BackIcon />
                </button>
            )}

            {mode === "rename" && view.kind === "category" ? (
                <input
                    autoFocus
                    className="vc-gc-header-input"
                    value={draft}
                    onChange={e => setDraft(e.currentTarget.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter") submitRename();
                        else if (e.key === "Escape") setMode("idle");
                    }}
                    placeholder={view.name}
                />
            ) : (
                <h2 className="vc-gc-title">{title}</h2>
            )}

            {mode === "rename" && (
                <>
                    <button type="button" className="vc-gc-icon-btn" aria-label="Save name" onClick={submitRename}>
                        <CheckIcon />
                    </button>
                    <button type="button" className="vc-gc-icon-btn" aria-label="Cancel rename" onClick={() => setMode("idle")}>
                        <XIcon />
                    </button>
                </>
            )}

            {mode === "delete" && view.kind === "category" && (
                <>
                    <span className="vc-gc-confirm-label">Delete?</span>
                    <button type="button" className="vc-gc-icon-btn vc-gc-danger" aria-label="Confirm delete" onClick={confirmDelete}>
                        <CheckIcon />
                    </button>
                    <button type="button" className="vc-gc-icon-btn" aria-label="Cancel delete" onClick={() => setMode("idle")}>
                        <XIcon />
                    </button>
                </>
            )}

            {mode === "idle" && isUserCategory && view.kind === "category" && (
                <>
                    <button
                        type="button"
                        className="vc-gc-icon-btn"
                        aria-label="Rename category"
                        onClick={() => { setDraft(view.name); setMode("rename"); }}
                    >
                        <PencilIcon />
                    </button>
                    <button
                        type="button"
                        className="vc-gc-icon-btn vc-gc-danger"
                        aria-label="Delete category"
                        onClick={() => setMode("delete")}
                    >
                        <TrashIcon />
                    </button>
                </>
            )}
        </header>
    );
}

function CategoriesView({
    data,
    favorites,
    query,
    onOpenCategory
}: {
    data: CategoryData;
    favorites: Gif[];
    query: string;
    onOpenCategory(name: string): void;
}) {
    const [newName, setNewName] = useState("");
    const [adding, setAdding] = useState(false);

    const tiles = useMemo(() => {
        const built: { id: string; label: string; gifs: Gif[]; }[] = [
            { id: ALL_FAVORITES, label: "All Favorites", gifs: favorites },
            {
                id: UNCATEGORIZED,
                label: "Uncategorized",
                gifs: favorites.filter(g => !data.assignments[g.url])
            }
        ];
        for (const name of data.order) {
            built.push({ id: name, label: name, gifs: gifsInCategory(name, favorites) });
        }
        const q = query.trim().toLowerCase();
        if (!q) return built;
        return built.filter(t => t.label.toLowerCase().includes(q));
    }, [data, favorites, query]);

    const submitNew = async () => {
        await createCategory(newName);
        setNewName("");
        setAdding(false);
    };

    return (
        <>
            <div className="vc-gc-gif-actions">
                <button type="button" className="vc-gc-chip" onClick={exportCategoryData}>
                    Backup
                </button>
                <button type="button" className="vc-gc-chip" onClick={importCategoryData}>
                    Restore
                </button>
                {query.trim() && !data.order.some(name => name.toLowerCase() === query.trim().toLowerCase()) && (
                    <button
                        type="button"
                        className="vc-gc-chip vc-gc-chip-primary"
                        onClick={async () => {
                            await createCategory(query);
                            setNewName("");
                            setAdding(false);
                        }}
                    >
                        Create Search
                    </button>
                )}
            </div>

            <div className="vc-gc-cat-grid">
                {tiles.map(tile => (
                    <button
                        key={tile.id}
                        type="button"
                        className="vc-gc-cat-tile"
                        onClick={() => onOpenCategory(tile.id)}
                        onContextMenu={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            ContextMenuApi.openContextMenu(e, () => (
                                <CategoryContextMenu category={tile.id} label={tile.label} gifs={tile.gifs} />
                            ));
                        }}
                    >
                        <CategoryPreview gifs={tile.gifs} />
                        <span className="vc-gc-cat-name">{tile.label}</span>
                        <span className="vc-gc-cat-count">{tile.gifs.length}</span>
                    </button>
                ))}

                {adding ? (
                    <div className="vc-gc-cat-tile vc-gc-cat-tile-add vc-gc-cat-tile-input">
                        <input
                            autoFocus
                            type="text"
                            value={newName}
                            placeholder="Category name"
                            onChange={e => setNewName(e.currentTarget.value)}
                            onKeyDown={e => {
                                if (e.key === "Enter") submitNew();
                                else if (e.key === "Escape") { setAdding(false); setNewName(""); }
                            }}
                        />
                        <div className="vc-gc-row">
                            <button type="button" className="vc-gc-btn vc-gc-btn-primary" onClick={submitNew}>Add</button>
                            <button type="button" className="vc-gc-btn" onClick={() => { setAdding(false); setNewName(""); }}>Cancel</button>
                        </div>
                    </div>
                ) : (
                    <button
                        type="button"
                        className="vc-gc-cat-tile vc-gc-cat-tile-add"
                        onClick={() => setAdding(true)}
                    >
                        <span className="vc-gc-plus" aria-hidden><PlusIcon /></span>
                        <span>New Category</span>
                    </button>
                )}
            </div>
        </>
    );
}

function CategoryPreview({ gifs }: { gifs: Gif[]; }) {
    const [previewRef, isNearViewport] = useNearViewport("350px 0px");
    const previewGifs = gifs.slice(0, 4);

    if (!previewGifs.length || !isNearViewport) {
        return <span ref={previewRef} className="vc-gc-cat-preview vc-gc-cat-preview-empty" aria-hidden />;
    }

    return (
        <span ref={previewRef} className={`vc-gc-cat-preview vc-gc-cat-preview-${previewGifs.length}`} aria-hidden>
            {previewGifs.map(gif => {
                const isVideo = isVideoSrc(gif.src, gif.format);
                return (
                    <span key={gif.url} className="vc-gc-cat-preview-cell">
                        {isVideo ? (
                            <video
                                src={gif.src}
                                autoPlay
                                loop
                                muted
                                playsInline
                                preload="metadata"
                            />
                        ) : (
                            <img src={gif.src} alt="" loading="lazy" decoding="async" />
                        )}
                    </span>
                );
            })}
        </span>
    );
}

function CategoryDetailView({
    categoryName,
    favorites,
    data,
    query,
    sort,
    onSelect
}: {
    categoryName: string;
    favorites: Gif[];
    data: CategoryData;
    query: string;
    sort: GifSort;
    onSelect(gif: Gif): void;
}) {
    const gifs = useMemo(() => {
        const list = gifsInCategory(categoryName, favorites);
        const q = query.trim().toLowerCase();
        const filtered = q
            ? list.filter(g => (g.url ?? "").toLowerCase().includes(q) || (g.src ?? "").toLowerCase().includes(q))
            : list;
        return sortGifs(filtered, sort);
    }, [categoryName, favorites, data, query, sort]);
    const { visibleGifs, visibleCount, hasMore, sentinelRef } = useProgressiveGifList(gifs, getGifListCacheKey(categoryName, `${sort}:${query}`));

    if (gifs.length === 0) {
        return (
            <div className="vc-gc-empty">
                {categoryName === ALL_FAVORITES
                    ? "You have no favorite GIFs yet. Favorite some in Discord's GIF picker."
                    : categoryName === UNCATEGORIZED
                        ? "All your favorites are categorized."
                        : "No GIFs in this category yet. Right-click a GIF in “All Favorites” to add it."}
            </div>
        );
    }

    return (
        <>
            <GifQuickActions gifs={gifs} onSelect={onSelect} />
            <div className="vc-gc-gif-grid">
                {visibleGifs.map(gif => (
                    <GifTile
                        key={gif.url}
                        gif={gif}
                        currentCategory={categoryName}
                        onSelect={onSelect}
                    />
                ))}
                {hasMore && (
                    <div ref={sentinelRef} className="vc-gc-gif-sentinel">
                        Loading more GIFs... {visibleCount}/{gifs.length}
                    </div>
                )}
            </div>
        </>
    );
}

function isVideoSrc(src: string, format: number) {
    if (!src) return false;
    if (/\.(mp4|webm|mov)(\?|$)/i.test(src)) return true;
    // Discord's proto enum uses 2 for video GIFs
    return format === 2;
}

function gifLabel(url: string) {
    try {
        const u = new URL(url);
        const slug = u.pathname.split("/").filter(Boolean).pop() ?? "";
        return slug.replace(/[-_]/g, " ").replace(/\.(gif|mp4|webm)$/i, "") || u.host;
    } catch {
        return url;
    }
}

function sortGifs(gifs: Gif[], sort: GifSort) {
    const sorted = [...gifs];
    switch (sort) {
        case GifSort.Name:
            return sorted.sort((a, b) => gifLabel(a.url).localeCompare(gifLabel(b.url)));
        case GifSort.Wide:
            return sorted.sort((a, b) => {
                const arA = a.width && a.height ? a.width / a.height : 1;
                const arB = b.width && b.height ? b.width / b.height : 1;
                return arB - arA;
            });
        case GifSort.Recent:
        default:
            return sorted.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
    }
}

function GifQuickActions({ gifs, onSelect }: { gifs: Gif[]; onSelect(gif: Gif): void; }) {
    const pickRandom = useCallback(() => randomGif(gifs), [gifs]);

    return (
        <div className="vc-gc-gif-actions">
            <button
                type="button"
                className="vc-gc-chip vc-gc-chip-primary"
                disabled={gifs.length === 0}
                onClick={() => {
                    const gif = pickRandom();
                    if (gif) onSelect(gif);
                }}
            >
                Random
            </button>
            <button
                type="button"
                className="vc-gc-chip"
                disabled={gifs.length === 0}
                onClick={() => {
                    const gif = pickRandom();
                    if (gif) copyText(gif.url);
                }}
            >
                Copy Random
            </button>
            <button
                type="button"
                className="vc-gc-chip"
                disabled={gifs.length === 0}
                onClick={() => copyText(gifs.map(g => g.url).join("\n"))}
            >
                Copy All
            </button>
            <button
                type="button"
                className="vc-gc-chip"
                disabled={gifs.length === 0}
                onClick={() => {
                    const gif = pickRandom();
                    if (gif) openGifUrl(gif.url);
                }}
            >
                Open Random
            </button>
        </div>
    );
}

function GifTile({
    gif,
    currentCategory,
    onSelect
}: {
    gif: Gif;
    currentCategory: string;
    onSelect(gif: Gif): void;
}) {
    const aspect = gif.width && gif.height ? gif.width / gif.height : 1;
    const [tileRef, isNearViewport] = useNearViewport();
    const [state, setState] = useState<"loading" | "loaded" | "error">(() => mediaStateCache.get(gif.src) ?? "loading");
    const label = gifLabel(gif.url);
    const isVideo = isVideoSrc(gif.src, gif.format);
    const shouldLoadMedia = isNearViewport || mediaStateCache.has(gif.src);

    useEffect(() => {
        setState(mediaStateCache.get(gif.src) ?? "loading");
    }, [gif.src]);

    const setCachedState = useCallback((nextState: "loaded" | "error") => {
        mediaStateCache.set(gif.src, nextState);
        setState(nextState);
    }, [gif.src]);

    const onContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        ContextMenuApi.openContextMenu(e, () => (
            <GifContextMenu gif={gif} currentCategory={currentCategory} />
        ));
    }, [gif, currentCategory]);

    return (
        <button
            ref={tileRef}
            type="button"
            className={`vc-gc-gif vc-gc-gif-${state}`}
            style={{ aspectRatio: String(aspect) }}
            onClick={() => onSelect(gif)}
            onContextMenu={onContextMenu}
            title={`${label} — click to send · right-click for options`}
            aria-label={label}
        >
            {shouldLoadMedia && (
                isVideo ? (
                    <video
                        src={gif.src}
                        autoPlay
                        loop
                        muted
                        playsInline
                        preload="metadata"
                        onLoadedData={() => setCachedState("loaded")}
                        onError={() => setCachedState("error")}
                    />
                ) : (
                    <img
                        src={gif.src}
                        alt={label}
                        loading="lazy"
                        decoding="async"
                        onLoad={() => setCachedState("loaded")}
                        onError={() => setCachedState("error")}
                    />
                )
            )}
            {state !== "loaded" && (
                <span className="vc-gc-gif-fallback">
                    {state === "error" ? label : "Loading…"}
                </span>
            )}
        </button>
    );
}

function CategoryContextMenu({
    category,
    label,
    gifs
}: {
    category: string;
    label: string;
    gifs: Gif[];
}) {
    const isUserCategory = category !== ALL_FAVORITES && category !== UNCATEGORIZED;

    return (
        <Menu.Menu
            navId="vc-gc-category-menu"
            onClose={ContextMenuApi.closeContextMenu}
            aria-label="GIF category options"
        >
            <Menu.MenuItem
                id="vc-gc-copy-category"
                label={`Copy ${gifs.length} GIF URLs`}
                disabled={gifs.length === 0}
                action={() => copyText(gifs.map(g => g.url).join("\n"))}
            />
            {gifs[0] && (
                <Menu.MenuItem
                    id="vc-gc-copy-first"
                    label="Copy cover GIF URL"
                    action={() => copyText(gifs[0].url)}
                />
            )}
            {gifs.length > 0 && (
                <>
                    <Menu.MenuItem
                        id="vc-gc-copy-random-category"
                        label="Copy random GIF URL"
                        action={() => copyText(randomGif(gifs).url)}
                    />
                    <Menu.MenuItem
                        id="vc-gc-open-random-category"
                        label="Open random GIF"
                        action={() => openGifUrl(randomGif(gifs).url)}
                    />
                </>
            )}
            {isUserCategory && (
                <>
                    <Menu.MenuSeparator />
                    <Menu.MenuItem
                        id="vc-gc-clear-category"
                        label={`Clear "${label}"`}
                        color="danger"
                        disabled={gifs.length === 0}
                        action={() => clearCategory(category)}
                    />
                </>
            )}
        </Menu.Menu>
    );
}

function GifContextMenu({
    gif,
    currentCategory
}: {
    gif: Gif;
    currentCategory: string;
}) {
    const data = useCategoryData();
    const assigned = data.assignments[gif.url];

    return (
        <Menu.Menu
            navId="vc-gc-gif-menu"
            onClose={ContextMenuApi.closeContextMenu}
            aria-label="GIF category options"
        >
            <Menu.MenuItem
                id="vc-gc-copy"
                label="Copy GIF URL"
                action={() => copyText(gif.url)}
            />
            <Menu.MenuItem
                id="vc-gc-copy-media"
                label="Copy media URL"
                action={() => copyText(gif.src)}
            />
            <Menu.MenuItem
                id="vc-gc-copy-markdown"
                label="Copy Markdown link"
                action={() => copyText(`[${gifLabel(gif.url)}](${gif.url})`)}
            />
            <Menu.MenuItem
                id="vc-gc-open"
                label="Open GIF in browser"
                action={() => openGifUrl(gif.url)}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="vc-gc-move" label={assigned ? `Move (current: ${assigned})` : "Add to category"}>
                {data.order.length === 0 ? (
                    <Menu.MenuItem id="vc-gc-no-cats" label="No categories — create one first" disabled />
                ) : (
                    data.order.map(name => (
                        <Menu.MenuCheckboxItem
                            key={name}
                            id={`vc-gc-cat-${name}`}
                            label={name}
                            checked={assigned === name}
                            action={() => assignGif(gif.url, assigned === name ? null : name)}
                        />
                    ))
                )}
            </Menu.MenuItem>
            {assigned && (
                <Menu.MenuItem
                    id="vc-gc-remove"
                    label="Remove from category"
                    color="danger"
                    action={() => assignGif(gif.url, null)}
                />
            )}
            {currentCategory !== ALL_FAVORITES && currentCategory !== UNCATEGORIZED && assigned === currentCategory && (
                <Menu.MenuItem
                    id="vc-gc-remove-here"
                    label={`Remove from "${currentCategory}"`}
                    color="danger"
                    action={() => assignGif(gif.url, null)}
                />
            )}
        </Menu.Menu>
    );
}

// for friends only ඞඞඞඞඞඞ
export default definePlugin({
    name: "GifCategories",
    description: "Adds a Categories tab to the expression picker so you can organize your favorite GIFs.",
    tags: ["Media", "Chat"],
    authors: [Devs.pfearr],

    settings,

    patches: [
        {
            find: "renderHeaderContent()",
            replacement: {
                match: /(,suggestions:\i,favorites:)(\i),/,
                replace: "$1$self.captureFavorites($2),"
            }
        }
    ],

    captureFavorites,

    async start() {
        await loadData();
        startObserver();
    },

    stop() {
        stopObserver();
    }
});
