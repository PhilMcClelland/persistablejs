#!/bin/sh
# Fills site/dist/ with the landing page as it is in the last commit.
set -eu
cd "$(dirname "$0")"
rm -rf dist
mkdir dist
git -C .. archive HEAD index.html | tar -x -C dist
