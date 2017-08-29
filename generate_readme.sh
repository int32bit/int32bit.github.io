#!/bin/bash

cat ./README.md.template >README.md
./populate_post_list.py >>README.md
