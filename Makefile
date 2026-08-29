# Makefile for MCP SuperAssistant Chrome Extension
# Requires Node.js >= 22.12.0 and pnpm

# Default target
.DEFAULT_GOAL := help

# Colors for output
GREEN := \033[0;32m
YELLOW := \033[0;33m
NC := \033[0m

## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##
## Setup and Dependency Check
## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##

# Setup .env file from example if missing
setup-env:
	@if [ ! -f ".env" ]; then \
		echo "$(YELLOW)Creating .env from .example.env...$(NC)"; \
		cp .example.env .env; \
	fi

# Install dependencies
install: setup-env
	@echo "$(GREEN)Installing dependencies...$(NC)"
	pnpm install --frozen-lockfile

# Install dependencies if not present (for build targets)
check-deps:
	@if [ ! -d "node_modules" ]; then \
		echo "$(YELLOW)Dependencies not found. Installing...$(NC)"; \
		$(MAKE) install; \
	fi

## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##
## Build Targets
## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##

# Build the extension (production)
build: check-deps
	@echo "$(GREEN)Building extension...$(NC)"
	pnpm build

# Build the extension for Firefox
build-firefox: check-deps
	@echo "$(GREEN)Building extension for Firefox...$(NC)"
	pnpm build:firefox

# Watch mode for development
dev: check-deps
	@echo "$(GREEN)Starting development server...$(NC)"
	pnpm dev

# Watch mode for Firefox development
dev-firefox: check-deps
	@echo "$(GREEN)Starting development server for Firefox...$(NC)"
	pnpm dev:firefox

# Build and create distribution zip
zip: build
	@echo "$(GREEN)Creating distribution zip...$(NC)"
	pnpm -F zipper zip

# Build for Firefox and create distribution zip
zip-firefox: build-firefox
	@echo "$(GREEN)Creating distribution zip for Firefox...$(NC)"
	pnpm -F zipper zip

## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##
## Clean Targets
## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##

# Clean all build artifacts and node_modules
clean:
	@echo "$(YELLOW)Cleaning build artifacts and node_modules...$(NC)"
	rm -rf node_modules dist 2>/dev/null || true
	@if [ -d "node_modules" ]; then \
		pnpm clean; \
	fi

# Clean only build artifacts (keeps node_modules) - works without node_modules
clean-bundle:
	@echo "$(YELLOW)Cleaning build artifacts...$(NC)"
	rm -rf dist 2>/dev/null || true
	@if [ -d "node_modules" ]; then \
		pnpm clean:bundle; \
	fi

## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##
## Utility Targets
## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##

# Run type checking
type-check: check-deps
	@echo "$(GREEN)Running type check...$(NC)"
	pnpm type-check

# Run linting
lint: check-deps
	@echo "$(GREEN)Running linter...$(NC)"
	pnpm lint

# Fix linting issues
lint-fix: check-deps
	@echo "$(GREEN)Fixing linting issues...$(NC)"
	pnpm lint:fix

# Format code with Prettier
prettier: check-deps
	@echo "$(GREEN)Formatting code...$(NC)"
	pnpm prettier

# Set global environment variables
set-env:
	@echo "$(GREEN)Setting global environment variables...$(NC)"
	pnpm set-global-env

## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##
## Release Targets
## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##

# Pack Chrome CRX locally
pack-crx: check-deps
	@echo "$(GREEN)Packing Chrome CRX...$(NC)"
	CHROME_PEM_KEY="$(CHROME_PEM_KEY)" node .github/scripts/generate-crx.js

# Generate update.xml locally
gen-update:
	@echo "$(GREEN)Generating update.xml...$(NC)"
	RELEASE_VERSION="$(VERSION)" GITHUB_REPOSITORY="$(REPO)" CHROME_APP_ID="$(APP_ID)" node .github/scripts/generate-update-xml.js

# Full release prep (build + zip + crx + update.xml)
release-prep: build build-firefox zip
	$(MAKE) pack-crx
	$(MAKE) gen-update
	@echo "$(GREEN)All artifacts ready in ./dist-zip$(NC)"

## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##
## Help
## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ## ##

help:
	@echo "MCP SuperAssistant - Chrome Extension Build System"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  install        Install dependencies"
	@echo "  clean          Clean all build artifacts and node_modules"
	@echo "  clean-bundle   Clean only build artifacts"
	@echo "  build          Build the extension (production)"
	@echo "  build-firefox  Build the extension for Firefox"
	@echo "  dev            Start development server (watch mode)"
	@echo "  dev-firefox    Start development server for Firefox (watch mode)"
	@echo "  zip            Build and create distribution zip"
	@echo "  zip-firefox    Build for Firefox and create distribution zip"
	@echo "  type-check     Run TypeScript type checking"
	@echo "  lint           Run ESLint"
	@echo "  lint-fix       Fix ESLint issues"
	@echo "  prettier       Format code with Prettier"
	@echo "  set-env        Set global environment variables"
	@echo "  release-prep   Full release prep (build + zip + crx + update.xml)"
	@echo "  pack-crx       Pack Chrome CRX locally"
	@echo "  gen-update     Generate update.xml locally"
	@echo ""
