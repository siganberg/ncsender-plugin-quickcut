#!/bin/bash

set -e

# Get the latest tag from all branches
LATEST_TAG=$(git tag --sort=-version:refname | head -1)
if [ -z "$LATEST_TAG" ]; then
    # No existing tags, start with v0.1.0
    NEW_VERSION="0.1.0"
    NEW_TAG="v0.1.0"

    echo "No existing tags found, starting with $NEW_TAG"

    # Update manifest.json version
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" manifest.json
    else
        sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" manifest.json
    fi

    echo ""
    echo "Updated manifest.json:"
    grep "\"version\":" manifest.json

    # Get all commit messages for initial release
    COMMITS=$(git log --pretty=format:"%s")

    # Skip to release notes generation
    GENERATE_NOTES=true
else
    echo "Latest tag: $LATEST_TAG"
    GENERATE_NOTES=false
fi

if [ "$GENERATE_NOTES" = false ]; then
    # Extract version number (remove 'v' prefix)
    VERSION=${LATEST_TAG#v}

    # Split version into major.minor.patch
    IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

    # Increment patch version
    PATCH=$((PATCH + 1))
    NEW_VERSION="$MAJOR.$MINOR.$PATCH"
    NEW_TAG="v$NEW_VERSION"

    echo "New version: $NEW_VERSION"
    echo "New tag: $NEW_TAG"

    # Update manifest.json version
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS (BSD sed)
        sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" manifest.json
    else
        # Linux (GNU sed)
        sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" manifest.json
    fi

    # Show the change
    echo ""
    echo "Updated manifest.json:"
    grep "\"version\":" manifest.json

    # Check if there are new commits since last tag
    echo ""
    if git rev-list "$LATEST_TAG..HEAD" --count | grep -q "^0$"; then
        echo "⚠️  No new commits since $LATEST_TAG"
        echo "Will update manifest.json with new version and create tag"
        echo ""

        # Commit the version change only
        git add manifest.json
        git commit -m "chore: create new release $NEW_TAG"

        # Push the commit
        git push origin $(git branch --show-current)

        # Create and push the tag
        git tag -a "$NEW_TAG" -m "Release $NEW_TAG"
        git push origin "$NEW_TAG"

        echo ""
        echo "✅ Successfully created and pushed $NEW_TAG"
        echo "CI pipeline will build the release at: https://github.com/siganberg/ncsender-plugin-surfacing/actions"
        exit 0
    fi

    # Get commit messages
    COMMITS=$(git log "$LATEST_TAG..HEAD" --pretty=format:"%s")
fi

echo "Generating release notes using Claude..."
echo ""

# Create a prompt for Claude
PROMPT="Based on the following git commit messages from $LATEST_TAG to HEAD, generate user-focused release notes for version $NEW_VERSION of the ToolBench plugin.

Commit messages:
$COMMITS

CRITICAL: Output ONLY the exact markdown format shown below. Do NOT add ANY other text.

Required format:
## What's Changed

### [emoji] [Category Name]
- [change description]
- [change description]

Rules:
1. Start with exactly \"## What's Changed\"
2. Group by category with emojis (✨ New Features, 🐛 Bug Fixes, 🔧 Improvements)
3. Use user-focused language
4. Exclude internal/chore commits unless they impact users
5. No markdown code blocks, URLs, links, or non-English characters
6. CRITICAL — INTRA-BRANCH CHURN: The commits below are the WORK done since the last release, not the delta from the user's perspective. It is common for one commit to add a feature and a later commit in the same range to fix a bug in THAT feature. The bug never shipped to users, so it MUST NOT appear as a \"Bug Fix\" entry. Report ONLY the NET user-facing outcome — describe the finished feature, do not list the mid-development fixes to it. A \"Bug Fix\" entry belongs in the release notes ONLY when it fixes a defect that existed in the PREVIOUS release (i.e. a real regression the user could have hit)

Output ONLY the markdown. No preamble. No explanation. Just the markdown."

# Use Claude CLI to generate release notes
# Only capture stdout — 2>&1 used to fold Claude CLI stderr warnings
# (e.g. "no stdin data received in 3s...") into the release body. Stderr
# still streams to the operator's terminal so real errors stay visible.
# /dev/null for stdin skips the "no stdin data" warning entirely.
RELEASE_NOTES=$(claude -p "$PROMPT" < /dev/null)
CLAUDE_EXIT_CODE=$?

if [ $CLAUDE_EXIT_CODE -ne 0 ] || [ -z "$RELEASE_NOTES" ]; then
    echo "❌ Failed to generate release notes with Claude"
    echo "Please make sure 'claude' CLI is installed and configured"
    echo ""
    echo "Falling back to basic release notes..."

    # Fallback: basic categorization
    RELEASE_NOTES_FILE=$(mktemp)
    echo "## What's Changed" > "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"

    # Simple categorization
    FEATURES=$(echo "$COMMITS" | grep -i "^feat\|^feature\|^add" || true)
    FIXES=$(echo "$COMMITS" | grep -i "^fix\|^bug" || true)
    OTHER=$(echo "$COMMITS" | grep -iv "^feat\|^feature\|^add\|^fix\|^bug\|^chore" || true)

    if [ -n "$FEATURES" ]; then
        echo "### ✨ New Features" >> "$RELEASE_NOTES_FILE"
        echo "$FEATURES" | while read -r line; do
            CLEAN_LINE=$(echo "$line" | sed -E 's/^(feat|feature|add|Add|Feature|Feat)://i' | sed 's/^[[:space:]]*//')
            echo "- $CLEAN_LINE" >> "$RELEASE_NOTES_FILE"
        done
        echo "" >> "$RELEASE_NOTES_FILE"
    fi

    if [ -n "$FIXES" ]; then
        echo "### 🐛 Bug Fixes" >> "$RELEASE_NOTES_FILE"
        echo "$FIXES" | while read -r line; do
            CLEAN_LINE=$(echo "$line" | sed -E 's/^(fix|bug|Fix|Bug)://i' | sed 's/^[[:space:]]*//')
            echo "- $CLEAN_LINE" >> "$RELEASE_NOTES_FILE"
        done
        echo "" >> "$RELEASE_NOTES_FILE"
    fi

    if [ -n "$OTHER" ]; then
        echo "### 📦 Other Changes" >> "$RELEASE_NOTES_FILE"
        echo "$OTHER" | while read -r line; do
            echo "- $line" >> "$RELEASE_NOTES_FILE"
        done
        echo "" >> "$RELEASE_NOTES_FILE"
    fi

    RELEASE_NOTES=$(cat "$RELEASE_NOTES_FILE")
    rm "$RELEASE_NOTES_FILE"
else
    echo "✅ Release notes generated successfully"
fi

# Save to latest_release.md file
RELEASE_NOTES_FILE="latest_release.md"
printf '%s\n' "$RELEASE_NOTES" > "$RELEASE_NOTES_FILE"

# Display release notes
echo ""
echo "========================================="
echo "Release Notes for $NEW_TAG:"
echo "========================================="
cat "$RELEASE_NOTES_FILE"
echo "========================================="

echo ""

# Commit the version change and release notes
git add manifest.json "$RELEASE_NOTES_FILE"
git commit -m "chore: create new release $NEW_TAG"

# Push the commit
git push origin $(git branch --show-current)

# Create and push the tag (using simple message since CI will use latest_release.md)
git tag -a "$NEW_TAG" -m "Release $NEW_TAG"
git push origin "$NEW_TAG"

echo ""
echo "✅ Successfully created and pushed $NEW_TAG"
echo "CI pipeline will build the release at: https://github.com/siganberg/ncsender-plugin-surfacing/actions"
