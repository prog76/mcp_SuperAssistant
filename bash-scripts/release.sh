#!/bin/bash
# Usage: ./bash-scripts/release.sh [patch|minor|major]
# Increments version based on the latest git tag, commits, tags and pushes.
# Pushing the v* tag triggers .github/workflows/release.yml to build & publish the release.
set -euo pipefail

BUMP="${1:-patch}"
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "Invalid bump type '$BUMP'. Use: patch | minor | major"; exit 1;;
esac

# Make sure we work from the repo root
cd "$(git rev-parse --show-toplevel)"

LATEST_TAG=$(git describe --tags --abbrev=0)
VERSION="${LATEST_TAG#v}"
echo "Latest tag: $LATEST_TAG (version $VERSION)"

IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0;;
  minor) MINOR=$((MINOR + 1)); PATCH=0;;
  patch) PATCH=$((PATCH + 1));;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
NEW_TAG="v$NEW_VERSION"

# Refuse to release with a dirty tree (except untracked files)
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Error: working tree has uncommitted changes. Commit or stash them first."
  exit 1
fi

echo "Bumping $BUMP version: $VERSION -> $NEW_VERSION"
bash bash-scripts/update_version.sh "$NEW_VERSION"

git add -- ':(glob)**/package.json'
git commit -m "chore: release $NEW_TAG"

git tag "$NEW_TAG"

echo "Pushing commits and tag $NEW_TAG..."
git push origin HEAD
git push origin "$NEW_TAG"

echo "✅ Released $NEW_TAG. GitHub Actions will build and publish the release."
