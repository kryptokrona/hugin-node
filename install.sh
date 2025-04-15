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

if [ "$NODE_VERSION" -lt 16 ]; then
    printf "${YELLOW}Node.js is missing or too old (need >=16). Do you want to install it? (y/n): ${NC}"
    read INSTALL_NODE
    if [ "$INSTALL_NODE" = "y" ] || [ "$INSTALL_NODE" = "Y" ]; then
        if echo "$OSTYPE" | grep -q "linux"; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt-get install -y nodejs
        elif echo "$OSTYPE" | grep -q "darwin"; then
            brew install node
        else
            error "Unknown OS or Windows detected. Please install Node.js manually from https://nodejs.org/"
            exit 1
        fi
        success "Node.js installed."
    else
        error "Node.js installation skipped. Exiting."
        exit 1
    fi
fi

# Check if git is installed
if ! command -v git >/dev/null 2>&1; then
    error "Git is not installed. Please install Git and rerun the script."
    exit 1
fi

# Check for Python (both python3 and python, plus Windows' `py`)
if command -v python3 >/dev/null 2>&1; then
    PYTHON_VERSION=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
    info "Detected Python version (via python3): $PYTHON_VERSION"
    MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
    MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)

    if [ "$MAJOR" -lt 3 ] || { [ "$MAJOR" -eq 3 ] && [ "$MINOR" -lt 6 ]; }; then
        warn "Python version is lower than 3.6 — you might encounter problems."
    else
        success "Python 3 is installed and recent enough."
    fi
elif command -v python >/dev/null 2>&1; then
    PYTHON_VERSION=$(python -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
    info "Detected Python version (via python): $PYTHON_VERSION"
    MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
    MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)

    if [ "$MAJOR" -lt 3 ] || { [ "$MAJOR" -eq 3 ] && [ "$MINOR" -lt 6 ]; }; then
        warn "Python version is lower than 3.6 — you might encounter problems."
    else
        success "Python 3 is installed and recent enough."
    fi
elif command -v py >/dev/null 2>&1; then
    PYTHON_VERSION=$(py -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
    info "Detected Python version (via py): $PYTHON_VERSION"
    MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
    MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)

    if [ "$MAJOR" -lt 3 ] || { [ "$MAJOR" -eq 3 ] && [ "$MINOR" -lt 6 ]; }; then
        warn "Python version is lower than 3.6 — you might encounter problems."
    else
        success "Python 3 is installed and recent enough."
    fi
else
    warn "Neither python, python3, nor py is found."
    printf "${YELLOW}Do you want to install Python3? (y/n): ${NC}"
    read INSTALL_PYTHON
    if [ "$INSTALL_PYTHON" = "y" ] || [ "$INSTALL_PYTHON" = "Y" ]; then
        if echo "$OSTYPE" | grep -q "linux"; then
            sudo apt-get update && sudo apt-get install -y python3 python3-pip
        elif echo "$OSTYPE" | grep -q "darwin"; then
            brew install python3
        elif echo "$OSTYPE" | grep -q "cygwin" || echo "$OSTYPE" | grep -q "mingw"; then
            info "Please download and install Python from https://www.python.org/downloads/."
            exit 1
        else
            error "Unknown operating system detected. Please install Python3 manually."
            exit 1
        fi
        success "Python3 installed."
    else
        error "Python3 installation skipped. Exiting."
        exit 1
    fi
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

# Ask for autostart
printf "${YELLOW}Do you want to auto-start the node on system startup? (y/n): ${NC}"
read AUTOSTART

if [ "$AUTOSTART" = "y" ] || [ "$AUTOSTART" = "Y" ]; then
    if [ "$USE_SCREEN" = true ]; then
        CRON_JOB="@reboot cd $WORKDIR/hugin-node && screen -dmS hugin-node npm run start"
    else
        CRON_JOB="@reboot cd $WORKDIR/hugin-node && npm run start"
    fi
    (crontab -l 2>/dev/null | grep -v 'hugin-node'; true) | { cat; echo "$CRON_JOB"; } | crontab -
    success "Autostart added to crontab."
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
