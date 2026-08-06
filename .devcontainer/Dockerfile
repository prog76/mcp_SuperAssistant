# Use the official Node.js 22 slim image (matches .nvmrc)
FROM node:22.12.0-slim

# Install system dependencies needed for development
RUN apt-get update && apt-get install -y \
    curl \
    jq \
    sudo \
    make \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally (package manager)
RUN npm install -g pnpm

# Create non-root user (same as in your original)
RUN useradd -m -s /bin/bash vscode && \
    echo 'vscode ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Create workspace directory (matches workspaceFolder in devcontainer.json)
RUN mkdir -p /SuperAssistant && chown -R vscode:vscode /SuperAssistant

# Switch to the non-root user
USER vscode
WORKDIR /SuperAssistant

# Keep container running
CMD ["sleep", "infinity"]
