#!/bin/sh

set -e

# === COLORS ===
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
NC='\033[0m' # No Color

info() {
    printf "${BLUE}[*] %s${NC}\n" "$1"
}

success() {
    printf "${GREEN}[✔] %s${NC}\n" "$1"
}

warn() {
    printf "${YELLOW}[!] %s${NC}\n" "$1"
}

error() {
    printf "${RED}[✘] %s${NC}\n" "$1"
}

WORKDIR=$(pwd)
info "Running in directory: $WORKDIR"

# Check if Node.js is installed and version >=16
if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node -v | sed 's/v//g' | cut -d. -f1)
    success "Detected Node.js version: $NODE_VERSION"
else
    NODE_VERSION=0
    warn "Node.js is not installed."
fi

# Handle Node.js installation using NVM, or nvm-windows for Windows users

# Check if we are on Windows
if echo "$OSTYPE" | grep -q "cygwin" || echo "$OSTYPE" | grep -q "mingw"; then
    # Special case for Windows with nvm-windows
    if ! command -v nvm >/dev/null 2>&1; then
        printf "${YELLOW}nvm-windows is not installed. Do you want to install it? (y/n): ${NC}"
        read INSTALL_NVM_WINDOWS
        if [ "$INSTALL_NVM_WINDOWS" = "y" ] || [ "$INSTALL_NVM_WINDOWS" = "Y" ]; then
            info "Please download and install nvm-windows from https://github.com/coreybutler/nvm-windows/releases."
            success "Please restart the terminal after installation."
            exit 1
        else
            error "nvm-windows installation skipped. Exiting."
            exit 1
        fi
    fi

    # If nvm-windows is installed, install Node.js version >= 18
    if [ "$NODE_VERSION" -lt 18 ]; then
        printf "${YELLOW}Node.js version is too old or missing. Do you want to install the latest stable version using nvm-windows? (y/n): ${NC}"
        read INSTALL_NODE
        if [ "$INSTALL_NODE" = "y" ] || [ "$INSTALL_NODE" = "Y" ]; then
            nvm install latest
            nvm use latest
            success "Node.js installed using nvm-windows."
        else
            error "Node.js installation skipped. Exiting."
            exit 1
        fi
    fi
else
    # For Linux/macOS users
    if [ "$NODE_VERSION" -lt 18 ]; then
        # Check if nvm is installed
        if ! command -v nvm >/dev/null 2>&1; then
            printf "${YELLOW}nvm (Node Version Manager) is not installed. Do you want to install it? (y/n): ${NC}"
            read INSTALL_NVM
            if [ "$INSTALL_NVM" = "y" ] || [ "$INSTALL_NVM" = "Y" ]; then
                # Install nvm
                curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash
                # Load nvm (it should be done in the profile, but just to be safe, we do it here)
                export NVM_DIR="$HOME/.nvm"
                [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
                success "nvm installed."
            else
                error "nvm installation skipped. Exiting."
                exit 1
            fi
        fi

        # Install Node.js using nvm if not installed or too old
        if [ "$NODE_VERSION" -lt 18 ]; then
            printf "${YELLOW}Node.js version is too old or missing. Do you want to install the latest stable version using nvm? (y/n): ${NC}"
            read INSTALL_NODE
            if [ "$INSTALL_NODE" = "y" ] || [ "$INSTALL_NODE" = "Y" ]; then
                nvm install stable
                nvm use stable
                success "Node.js installed using nvm."
            else
                error "Node.js installation skipped. Exiting."
                exit 1
            fi
        fi
    else
        success "Node.js is up to date."
    fi
fi

# Ensure nvm is loaded for the current shell session
if [ -n "$NVM_DIR" ]; then
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
fi

# Check if git is installed
if ! command -v git >/dev/null 2>&1; then
    error "Git is not installed. Please install Git and rerun the script."
    exit 1
fi

# Clone the repo
if [ ! -d "$WORKDIR/hugin-node" ]; then
    info "Cloning the hugin-node repository..."
    git clone https://github.com/kryptokrona/hugin-node.git
    success "Repository cloned."
else
    warn "Directory hugin-node already exists, skipping git clone."
fi

cd "$WORKDIR/hugin-node"

# Install npm dependencies with loading dots
info "Installing npm dependencies..."
(
    npm install --silent &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
        printf "."
        sleep 1
    done
)
printf "\n"
success "npm dependencies installed."

# Check if screen is installed
USE_SCREEN=false
if ! command -v screen >/dev/null 2>&1; then
    printf "${YELLOW}screen is not installed. Do you want to install it? (y/n): ${NC}"
    read INSTALL_SCREEN
    if [ "$INSTALL_SCREEN" = "y" ] || [ "$INSTALL_SCREEN" = "Y" ]; then
        if echo "$OSTYPE" | grep -q "linux"; then
            sudo apt-get update && sudo apt-get install -y screen
            USE_SCREEN=true
        elif echo "$OSTYPE" | grep -q "darwin"; then
            brew install screen
            USE_SCREEN=true
        else
            warn "Please install 'screen' manually on Windows or your OS."
            USE_SCREEN=false
        fi
    else
        warn "screen installation skipped."
        USE_SCREEN=false
    fi
else
    USE_SCREEN=true
fi

# Ask for autostart if it's not a Windows system
if echo "$OSTYPE" | grep -q "linux" || echo "$OSTYPE" | grep -q "darwin"; then
    printf "${YELLOW}Do you want to auto-start the node on system startup? (y/n): ${NC}"
    read AUTOSTART

    if [ "$AUTOSTART" = "y" ] || [ "$AUTOSTART" = "Y" ]; then
        if [ "$USE_SCREEN" = true ]; then
            CRON_JOB="@reboot export NVM_DIR=\"$HOME/.nvm\" && [ -s \"$NVM_DIR/nvm.sh\" ] && \. \"$NVM_DIR/nvm.sh\" && cd $WORKDIR/hugin-node && screen -dmS hugin-node npm run start"
        else
            CRON_JOB="@reboot export NVM_DIR=\"$HOME/.nvm\" && [ -s \"$NVM_DIR/nvm.sh\" ] && \. \"$NVM_DIR/nvm.sh\" && cd $WORKDIR/hugin-node && npm run start"
        fi
        (crontab -l 2>/dev/null | grep -v 'hugin-node'; true) | { cat; echo "$CRON_JOB"; } | crontab -
        success "Autostart added to crontab."
    fi
else
    info "Skipping autostart setup for Windows (crontab not supported)."
fi


# === Start the node ===
if [ "$USE_SCREEN" = true ]; then
    info "Starting hugin-node in a screen session named 'hugin-node'..."
    screen -dmS hugin-node npm run start
    sleep 1
    info "Attaching to screen now! ${YELLOW}(Press Ctrl+A, then Ctrl+D to detach)${NC}"
    screen -r hugin-node
else
    warn "'screen' not available, starting hugin-node directly in foreground."
    info "Running: npm run start"
    npm run start
fi
