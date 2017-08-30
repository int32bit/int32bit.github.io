#!/usr/bin/env python3
#code=utf-8
import os
from glob import glob

BLOG_URL = 'http://int32bit.me'


def get_posts(post_dir="./_posts"):
    posts = []
    for f in glob(post_dir + "/*.md"):
        posts.append(extract_post_metadata(f))
    return sorted(posts, key=lambda s: s[1], reverse=True)


def extract_post_metadata(path):
    # demo 2017-08-28-如何阅读OpenStack源码.md
    title = os.path.basename(path)[11:-3]
    date = os.path.basename(path)[:10]
    tags = []
    with open(path, 'r') as f:
        started = False
        for line in f:
            if line.strip() == '---':
                if started:
                    break
                else:
                    started = True
            if line.strip().startswith('tags'):
                # line = 'tags: [Linux, OpenStack]\n'
                t = line.split(':')[1].strip()[1:-1].split(',')
                tags = [i.strip() for i in t]
                break
    return title, date, tags


def generate_post_url(date, title):
    return ''.join([BLOG_URL,
                    '/',
                    date.replace('-', '/'),
                    '/',
                    title.replace(' ', '-'),
                   ])


def print_as_markdown_table(posts):
    header = ['序号', '文章标题', '文章类别', '发布日期']
    print(_convert_to_md_row(header))
    print(_convert_to_md_row(['----'] * len(header)))
    count = 0
    for post in posts:
        count = count + 1
        title = post[0]
        date = post[1]
        tags = post[2]
        post_url = generate_post_url(date, title)
        target = "[%(title)s](%(url)s)" % {"title": title, "url": post_url}
        print(_convert_to_md_row([str(count), target, ', '.join(tags), date]))


def _convert_to_md_row(fields):
    return '|' + '|'.join(fields) + '|'


def main():
    posts = get_posts(post_dir="./_posts")
    print_as_markdown_table(posts)


if __name__ == "__main__":
    main()
