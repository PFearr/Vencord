# no shabang

# the all in one script that downloads and executes this shit


read -p "This script will install a folder called Vencord to the current directory. You will be able to delete it in the end. Do you want to continue? (y/n): " -n 1 -r
echo    # move to a new line
if [[ $REPLY =~ ^[Yy]$ ]]
then
    echo "Continuing with the script..."
else
    echo "Exiting script."
    exit
fi

ALLOW_INSTALL=0

# IMPORTANT: Does the user want us to install things that are required to run this script? (node/npm/git/pnpm)
read -p "This script requires Node.js, npm, git, and pnpm to run. If they are not installed, would you like to install them? (y/n): " -n 1 -r
echo    # move to a new line
if [[ $REPLY =~ ^[Yy]$ ]]
then
    ALLOW_INSTALL=1
else
    echo "You have chosen not to install the required dependencies. The script will now check if they are installed and exit if they are not."
fi

# Check if node/npm is installed
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null
then
    if [ $ALLOW_INSTALL -eq 1 ]; then
        # Check if brew, apt, or pacman is installed and use it to install nvm
        if command -v brew &> /dev/null
        then
            echo "Homebrew is installed. Installing nvm using Homebrew..."
            brew install nvm
        elif command -v apt &> /dev/null
        then
            echo "apt is installed. Installing nvm using apt..."
            sudo apt update
            sudo apt install nvm
        elif command -v pacman &> /dev/null
        then
            echo "pacman is installed. Installing nvm using pacman..."
            sudo pacman -S nvm
        else
            echo "No supported package manager found. Please install Node.js and npm manually and try again."
            exit
        fi

        # Use NVM to install "node": ">=18"
        echo "Installing Node.js version 18 or higher using nvm..."
        nvm install 18
        nvm use 18

        
    else
        echo "Node.js and npm are required to run this script. Please install them and try again."
        echo "Mac and Linux users can use nvm (Node Version Manager) to easily install and manage Node.js versions"
        exit
    fi
fi

# Check if git is installed
if ! command -v git &> /dev/null
then
    if [ $ALLOW_INSTALL -eq 1 ]; then
        # Check if brew, apt, or pacman is installed and use it to install git
        if command -v brew &> /dev/null
        then
            echo "Homebrew is installed. Installing git using Homebrew..."
            brew install git
        elif command -v apt &> /dev/null
        then
            echo "apt is installed. Installing git using apt..."
            sudo apt update
            sudo apt install git
        elif command -v pacman &> /dev/null
        then
            echo "pacman is installed. Installing git using pacman..."
            sudo pacman -S git
        else
            echo "No supported package manager found. Please install git manually and try again."
            exit
        fi
    else
        echo "Git is required to run this script. Please install it and try again."
        exit
    fi
fi

# check if pnpm is installed, if not install it globally using npm
if ! command -v pnpm &> /dev/null
then
    echo "pnpm is not installed. Installing it globally using npm..."
    npm install -g pnpm
fi

# If everything installed successfully, da script SHALL work!
# Clone the repository
git clone https://github.com/PFearr/Vencord && cd Vencord
# Install dependencies using pnpm
pnpm install
# Build the project
pnpm run build
# Run the injector
pnpm run inject

# Delete the repository after injection (ask for user input)
read -p "Do you want to delete the Vencord repository? (y/n) " -n 1 -r
echo    # move to a new line
if [[ $REPLY =~ ^[Yy]$ ]]
then
    cd ..
    rm -rf Vencord
    echo "Vencord repository deleted."
else
    echo "Vencord repository not deleted. All installed!"
fi