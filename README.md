# 🐝 Plan Bee

Adulting is hard. Hope this makes it easy.

**Try it:** [dianakarp.github.io/PlanB](https://dianakarp.github.io/PlanB/)

Plan Bee finds the day that works for you and your friends. There are no accounts or sign-ups: make a plan, send the link, and everyone taps the days they're free.

## What it does

- **A link for every plan.** Share it in the group chat, and whoever has it can add their days.
- **Tap the days you're free.** Each day fills with honey as more people pick it.
- **Plan A, B and C.** The three days the most people can make, with who's in and who's missing.
- **Notes.** Add a comment like "only after 6pm" if your days come with limits.
- **Optional PIN.** Lock your answers so nobody else can change them.
- **Fix a plan later.** Whoever made the plan can change its name and dates from the same browser.
- **Cleans up after itself.** Plans are deleted 30 days after their last day.

## How it's built

- **`index.html`** is the whole site: one page of HTML, CSS and JavaScript with no frameworks, hosted on GitHub Pages.
- **Plans are saved** by a small [Cloudflare Worker](https://developers.cloudflare.com/workers/) with a [D1](https://developers.cloudflare.com/d1/) database, both on Cloudflare's free plan.
- **`worker/worker.js`** is the Worker's code. Cloudflare runs the copy in the Worker's online editor, not this one, so after changing this file, paste it there and deploy.
- **The two connect** through the `API_URL` line near the top of the script in `index.html`.

## Privacy

There are no accounts, ads or analytics. A plan stores its name and dates, a hashed key that lets the browser that made it change it, plus each person's name, days, optional comment and a hashed version of their PIN (never the PIN itself). Anyone with a plan's link can see it and change answers that aren't locked with a PIN, so keep comments casual.

---

A tiny project by [dianakarp](https://github.com/dianakarp) to socialize more · est. Nov 2026
