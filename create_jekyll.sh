#!/bin/sh
NAME=jekyll
IMAGE=jekyll/jekyll
docker rm -f $NAME &>/dev/null
docker run -d --hostname $NAME --name $NAME --label=jekyll --volume=$(pwd):/srv/jekyll -p 4000:4000 $IMAGE jekyll serve
