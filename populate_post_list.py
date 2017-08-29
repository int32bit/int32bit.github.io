#!/usr/bin/env python3
#code=utf-8

import os
from glob import glob

BLOG_URL = 'http://int32bit.me'


def get_post_files(post_dir="./_posts"):
    posts = []
    for f in glob(post_dir + "/*.md"):
        posts.append(os.path.basename(f))
    return posts


def get_posts(files):
    posts = list(map(lambda s: (s[:10], s[11:-3]), files))
    return sorted(posts, key=lambda s: s[0], reverse=True)


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
        date = post[0]
        title = post[1]
        post_url = generate_post_url(date, title)
        target = "[%(title)s](%(url)s)" % {"title": title, "url": post_url}
        print(_convert_to_md_row([str(count), target, 'OpenStack', date]))


def _convert_to_md_row(fields):
    return '|' + '|'.join(fields) + '|'


def main():
    files = get_post_files()
    posts = get_posts(files)
    print_as_markdown_table(posts)


if __name__ == "__main__":
    main()
