# WebDesigner71 CMS — Phase 4: Posts (blog)

Status: implemented. Last updated 2026-11-02. Builds on [Phase 3](cms-phase3.md), which it reuses: the visual editor, block renderer, media library, login and approval, and modals. Phase 2 (homepage) and Phase 3 (pages) are unchanged, and the live homepage is byte-identical (md5 `241043ff60c5c91a410b022477e994aa`, 43 734 bytes).

## Scope
- **Admin → পোস্ট** (list):
  - status tabs with counts: সব / প্রকাশিত / শিডিউল / খসড়া / ট্র্যাশ
  - search by title or slug, a category filter, and a pager (20 per page)
  - bulk select with a sticky bulk bar: publish, unpublish, trash, restore, delete permanently
  - per-row actions: ✎ edit, ⚙ info/SEO, 📋 duplicate, ▶ publish / ⏸ unpublish, 🗑 trash; in Trash: ↺ restore, 🗑 delete forever
  - on a phone the table becomes cards, and every action is still reachable
- **Create dialog**:
  - title; the slug is generated automatically and can be edited
  - optional categories
  - reserved and invalid slugs are rejected inline
- **Post editor**: the Phase 3 full-screen visual editor (desktop, tablet, phone) in *post mode*:
  - the preview shows the real post header: breadcrumb, title, category chips, author, date, reading time, excerpt lead, featured image, tags and share links
  - clicking the title or meta in the preview opens **পোস্টের তথ্য ও SEO**
  - that dialog has: title, slug (with a live URL preview), excerpt, featured image plus alt, categories (create a new one inline), tags (type, then Enter; existing tags are reused), author, and publish date/time in Bangladesh time (এখন / খালি buttons), plus SEO title, description, share image and noindex
  - reading time is computed automatically (Bengali-aware word count, 200 wpm), so there is nothing to type
  - new blog blocks, grouped first in the library:
    - **সূচিপত্র (TOC)**: built from the post's headings, with anchor links
    - **কলআউট**: info, tip, warning or success; icon, title, text
    - **কোড**: LTR monospace; Tab inserts a tab; language label; escaped output
    - **গ্যালারি**: 2–4 columns, alt and caption, lazy-loaded
- **Statuses**: draft → published, or **scheduled**, which means published with a future date.
  - There is no cron. The site worker compares the date with the request time, so a scheduled post appears on its own once its time passes (the KV cache is ≤ 60 s).
  - Publishing with an empty date sets the date to "now".
  - Trash is soft and can be restored; restored posts come back as drafts.
  - Drafts and unpublished edits are **admin-only**. They are previewed only inside the editor's iframe bridge and never get a public URL.
- **Category and tag manager** (ক্যাটাগরি ও ট্যাগ):
  - create, rename, change the slug, delete (with a confirm showing how many posts use the term)
  - deleting a term removes it from posts silently; posts are never broken
  - limits: 50 categories, 200 tags; 5 categories and 15 tags per post
- **Public blog** (Bengali, inside the site's own header, footer and colours):
  - `/blog`: card grid, 9 per page; `/blog/page/N` (page 1 redirects 301 to `/blog`)
  - `/blog/<slug>`: article with meta, TOC anchors, prev/next, three related posts (shared categories/tags), share links (Facebook, WhatsApp, X, LinkedIn, email), canonical, Open Graph / Twitter meta and BlogPosting JSON-LD
  - `/blog/category/<slug>` and `/blog/tag/<slug>`, both paginated
  - `/blog/feed.xml`: RSS 2.0 with the latest 20 posts
  - `/sitemap.xml` now lists `/blog` and every visible post once at least one is published (noindex posts are excluded)
  - an old slug redirects 301 to the new one (up to 10 old slugs per post)
  - unknown and scheduled posts get the styled 404
- **Media library**:
  - every card shows where the image is used: হোমপেজ / পেজ: … / পোস্ট: …
  - deleting an image used by pages or posts asks first and names them; only after confirming does the UI send `?force=1`
  - images used on the homepage still cannot be deleted from the UI, which sends you to the section instead (the Phase 2 behaviour)
- **Dashboard**: a posts stat card (total and number published) and a quick link.

Not in scope: comments, multiple authors with their own logins, revisions beyond one undo step, newsletter.

## 1. Why it's simpler than WordPress, Shopify, Wix and Squarespace

| Product | Their problem | What we do |
|---|---|---|
| WordPress | Separate Gutenberg editor screens; scheduling depends on WP-Cron (misses when there's no traffic); categories and tags live on separate screens | One editor with the real page preview; scheduling is a date (no cron, can't miss); one terms screen; inline new category/tag |
| Shopify blog | Plain rich-text editor, no blocks, weak SEO controls | Full block editor plus TOC, callout, code and gallery; SEO, share image and noindex per post |
| Wix blog | Separate blog app with a different editor, heavy pages | The same editor as Pages; static HTML output with no client JS |
| Squarespace | Few post settings, no bulk actions, clumsy on a phone | Bulk actions, a filtered list and the full phone layout |

## 2. Data (KV `CONTENT`)
| Key | What |
|---|---|
| `post:<id>` | The working copy: title, slug, excerpt, image, categories, tags, author, date, seo, blocks, status, version |
| `post:<id>:prev` | One undo step |
| `posts:index` | Admin list (no blocks) |
| `posts:public` | Public list of published entries (dates included; filtered at request time) |
| `postpub:<slug>` | The published snapshot that visitors see (cleaned by `cleanSnapshot`) |
| `postredirect:<old-slug>` | `{to}` for 301s |
| `posts:terms` | `{categories:[{id,name,slug}], tags:[…], version}` |

Shared renderer and model: `public/cms/posts.js`. `admin-worker/src/cms-posts.js` is the same file with only the import path changed, and a test checks this. Every value is validated against a whitelist (CSS values, URLs limited to http(s), `/media/` or same-site), HTML is escaped, and the code block is never executed.

Reserved slugs: `page category tag feed feed-xml rss preview index search author`. Posts live under `/blog/`, so they can't shadow `/admin/`, `/media/`, `/cms/` or pages.

## 3. Admin API (admin only; every write needs `version` for optimistic locking, and a stale version returns 409)
- `GET /admin/posts`: index plus terms
- `POST /admin/posts`: create
- `POST /admin/posts/bulk` `{action, ids}`
- `GET|PUT|DELETE /admin/posts/<id>` (DELETE needs `?version=` and only works on trashed posts)
- `POST /admin/posts/<id>/{publish|unpublish|trash|restore|duplicate|undo}`
- `POST /admin/posts/terms`, `PUT|DELETE /admin/posts/terms/<id>`
- `DELETE /admin/media/<key>`: 409 `{usedIn, usedBy}` when the image is in use, unless `?force=1` (the Phase 2 contract is unchanged)

## 4. Tests
- `node site-worker/test/check.mjs`: 153 site checks (blog routes, RSS, sitemap, scheduled hiding, homepage byte-identity)
- `cd admin-worker && node test/e2e.mjs`: 249 API checks, including posts, terms, bulk, schedule, trash and media usage
- `node site-worker/test/admin-ui.mjs`: 144 checks; `node site-worker/test/pages-ui.mjs`: 68 checks
- `SHOTS=/workspace/cms4_shots node site-worker/test/posts-ui.mjs`: **75 checks**. Headless Chrome at 1440 px and 390 px against a mocked backend: list, filters, bulk, trash, terms, create, editor blocks, settings, schedule, media usage, dashboard and phone layout.

## 5. How to use
1. Admin → **পোস্ট** → **+ নতুন পোস্ট**. Enter a title, then **তৈরি করুন**.
2. Write in the editor. Add blocks from the left (the blog group is on top). Click the title in the preview to set the excerpt, featured image, categories, tags, date and SEO.
3. Click **সেভ**, then **প্রকাশ করুন**. If the date is in the future, the button reads **শিডিউল করুন**.
4. Manage categories and tags under **ক্যাটাগরি ও ট্যাগ**. Readers see the posts at `/blog`.
