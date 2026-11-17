# Reddit Scraper

Scrapes every comment from a Reddit post, or the top five posts of a subreddit.

## Requirements

- Node.js 20 or newer
- A Reddit account

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
REDDIT_USERNAME=your_user
REDDIT_PASSWORD=your_password
```

## Usage

```bash
node scraper.js https://www.reddit.com/r/example/comments/abc123/title/
node scraper.js https://www.reddit.com/r/example/
```

Results are written to `output/` as plain text.

## Limits

Reddit changes its internal endpoints without notice, so selectors and routes may break. The tool logs in with your account and is subject to Reddit rate limits. Use it responsibly.
