#!/bin/sh
# Copy seed documents into the storage directory if they don't already exist.

SEED_DIR="/seed-documents"
DATA_DIR="/data/documents"

if [ -d "$SEED_DIR" ]; then
  for file in "$SEED_DIR"/*; do
    [ -f "$file" ] || continue
    docname=$(basename "$file")
    target="$DATA_DIR/$docname"

    if [ ! -f "$target" ]; then
      cp "$file" "$target"
      echo "Seeded: $docname"
    else
      echo "Exists: $docname (skipped)"
    fi
  done
fi

exec provider "$@"
