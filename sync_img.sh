#!/bin/bash

POST_FILE=$1
IMAGE_SRC=${2:-~}
if [[ -z "$POST_FILE" ]]; then
    echo "Usage $0 <post_file> [image_src]"
    exit 1
fi
POST_NAME=$(head -n 5 <"$POST_FILE" | awk '/title:/{print $2}')
IMAGE_TARGET="./img/posts/$POST_NAME"
mkdir -p "$IMAGE_TARGET"
for img in $(grep -P '!\[.+\]\(.+\)' "$POST_FILE" | grep -Po '\(.+\)' | tr -d '()'); do
    BASE_NAME=$(basename "$img")
    cp -vf "$IMAGE_SRC/$BASE_NAME" "$IMAGE_TARGET/$BASE_NAME"
done
