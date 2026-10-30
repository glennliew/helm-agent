#!/bin/zsh
# Create a fresh copy of the Tides example project as its own git repository.
# usage: zsh examples/tides/setup.sh [target-dir]   (default: ~/helm-walkthrough/tides)
set -eu
SRC=${0:A:h}
DEST=${1:-$HOME/helm-walkthrough/tides}
if [[ -e $DEST ]]; then
  print -r -- "$DEST already exists. Remove it first (rm -rf '$DEST') to start over."
  exit 1
fi
mkdir -p $DEST
cp -R $SRC/tides $SRC/tests $SRC/README.md $DEST/
# A fake credential, so you can watch Guard keep it away from the model.
cp $SRC/env.example $DEST/.env
print -r -- ".env" > $DEST/.gitignore
print -r -- "__pycache__/" >> $DEST/.gitignore
cd $DEST
git init -q -b main
git add -A
git -c user.name="Tides Dev" -c user.email=dev@example.com commit -qm "Tides: passage planning helpers"
print -r -- "Created $DEST (git repo, 1 commit). Next:"
print -r -- "  cd '$DEST'"
print -r -- "  python3 -m unittest      # 7 of 8 tests fail"
