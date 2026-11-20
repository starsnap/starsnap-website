"""Write review-data.json to stdout. Keep this file outside the public assets."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from html import unescape
from pathlib import Path
from urllib.request import urlopen
import json
import re
import unicodedata


BASE = 'https://www.bskorea.or.kr/bible/'
ROOT = Path(__file__).resolve().parent
VERSE = re.compile(r'<span class="number">\s*(?:<a name=focus></a>)?(\d+)(?:&nbsp;|\s)*</span>')


def fetch(url):
    with urlopen(url, timeout=15) as response:
        data = response.read()
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return data.decode('cp949')


def passage(reference, books):
    book, address = reference.rsplit(' ', 1)
    chapter, numbers = address.split(':')
    first, _, last = numbers.partition('–')
    code = books[book]
    url = BASE + f'korbibReadpage.php?linkBible=BGAE{code}{int(chapter):03d}{int(first):03d}'
    page = fetch(url)
    if f'korbibclip01.php?version=GAE&book={code}&chap={chapter}&sec={first}' not in page:
        raise ValueError(f'Unexpected chapter or edition for {reference}')
    markers = list(VERSE.finditer(page))
    verses = []
    for number in range(int(first), int(last or first) + 1):
        matches = [index for index, marker in enumerate(markers) if int(marker[1]) == number]
        if len(matches) != 1:
            raise ValueError(f'Unable to locate {book} {chapter}:{number}')
        index = matches[0]
        stop = markers[index + 1].start() if index + 1 < len(markers) else len(page)
        raw = page[markers[index].end():stop]
        raw = re.sub(r'<div\b[^>]*class\s*=\s*["\']?D2\b[^>]*>.*?</div>', '', raw, flags=re.I | re.S)
        raw = re.sub(r'<a\b[^>]*class\s*=\s*["\']?comment\b[^>]*>.*?</a>', '', raw, flags=re.I | re.S)
        end = re.search(r'</font>\s*</span>', raw, re.I)
        if not end:
            raise ValueError(f'Unable to read {book} {chapter}:{number}')
        verses.append(unescape(re.sub(r'<[^>]+>', '', raw[:end.start()])))
    text = unicodedata.normalize('NFKC', ' '.join(verses)).lower()
    return ''.join(char for char in text if unicodedata.category(char)[0] in 'LMN')


if __name__ == '__main__':
    source = (ROOT / 'answer-digests.mjs').read_text(encoding='utf-8')
    digests = json.loads(source.split('export const answerDigests = ', 1)[1].strip().removesuffix(';'))
    books = dict(re.findall(r'szGAEBook\[\d+\]\s*=\s*new Array\("([^"]+)", "([a-z0-9]+)"', fetch(BASE + 'js/bible.list.js')))
    books['요한일서'] = '1jn'
    with ThreadPoolExecutor(max_workers=4) as pool:
        answers = dict(zip(digests, pool.map(lambda reference: passage(reference, books), digests)))
    for reference, text in answers.items():
        if sha256(text.encode()).hexdigest() != digests[reference]:
            raise ValueError(f'Official passage does not match the grading digest for {reference}')
    print(json.dumps(answers))
