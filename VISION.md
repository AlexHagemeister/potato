# Potato: vision

This file describes what Potato is and how it feels to use. It holds intent, not implementation. A sentence belongs here only if no implementation surprise would make you rewrite it. The file changes rarely, and only by Alex's decision.

**Operating clause.** When an implementation choice fights an invariant below, stop and surface the conflict. Do not build around it. When a tool turns out not to fit, drop the tool, not the invariant.

The file has three parts. **Core** is what holds no matter what gets built. **Possibility space** is where Potato could go, with nothing in it committed. **Open tensions** are questions that are not settled yet. When work reaches an open tension, surface it instead of picking a side.

# Core

## What Potato is

Potato is a way to decide what to watch, one title at a time. It shows you a movie or TV series as a card. You make a quick call on it, and the next card appears. Over time your calls build a watchlist, a record of what you passed on, and a record of what you have seen, with your ratings and reviews.

The core feeling is speed without pressure. Sorting a card takes a few seconds. You never have to give a verdict you are not ready to give.

## The deck

The deck is the main screen. It shows one card at a time.

A card scrolls vertically. From top to bottom it shows:

- the poster
- the title, year, and type (movie or series)
- the genres, and the runtime (movie) or number of seasons (series)
- the IMDb rating
- a short synopsis
- where you can stream it in your country, with your own services highlighted
- the trailer, which plays inside the card and can go fullscreen

Four buttons sit at the bottom of the screen, visible while you scroll the card:

1. **Pass.** You don't want to watch it. It goes to your Passed list.
2. **Skip.** You are not ready to decide. It goes to no list, and it returns to the deck after a while.
3. **Watchlist.** You want to watch it. It goes to your Watchlist.
4. **Seen it.** You have already watched it. You rate it, and you can write a review. It goes to your Seen list.

A title on any list never returns to the deck.

## Ratings and reviews

A rating is half a star to 10 stars, in half-star steps. A review is free text and is optional. A series gets one rating and one review for the whole show. Ratings and reviews belong to your profile and live inside Potato.

## Your lists

You have three lists: Watchlist, Passed, and Seen. Every choice can be undone:

- A Watchlist title can be marked as seen, which asks for a rating and moves it to Seen.
- A Passed title can move to the Watchlist.
- A rating or review can be edited at any time.

The filters that shape the deck also work on each list.

## Search

You can search for any title at any time. A search result opens the same card you see in the deck, with the same four buttons (a title you've already rated shows Edit rating instead). This covers two common moments: you saw a trailer somewhere and want the title on your Watchlist, or you just finished something and want to rate it.

## Shaping the deck

**Filters** decide which titles can appear:

- movie or series
- genre
- era (for example, recent releases only)
- available on my streaming services

**Discovery mode** decides which titles come up and what they lean toward:

- popular
- deep cuts (good titles fewer people know)
- top rated
- for you (based on your own ratings)

Each time you choose a mode or filters, or open the app, the deck is a fresh deal: the same choice never gives the same run of cards twice.

The default mode is a blend of these. "For you" needs ratings to work. Until you have rated enough titles, choosing "For you" shows an empty state that asks you to rate more titles to unlock it.

The test case: "a good modern sci-fi series on something I already pay for" takes a few taps.

## Navigation

The app opens directly on the deck. A tab bar along the bottom holds the main places:

- **Discover:** the deck, with its filter and mode controls
- **Search**
- **Lists:** Watchlist, Seen, and Passed
- **Profile:** your settings and account

The four card buttons sit just above the tab bar. Both rows are within thumb reach on a phone.

## Your account and settings

You sign in with Google. Everything you do is saved to your profile and follows you across devices. Settings hold your country and the streaming services you use. These drive the streaming info on each card and the "on my services" filter.

## Your data and your AI

Your lists, ratings, and reviews are yours, and you can connect them to the AI assistant of your choice. The AI reads them and writes to them.

The test case: you talk about a movie you just watched with your AI, then say "turn what I said into a review, I'd give it 8/10." The review appears in your Seen list, the same as if you had written it in the app.

## How it feels

Potato runs as a web app saved to the iPhone home screen. It feels like a native app: fast, one-handed, no visible page loads, nothing that looks like a website.

## Invariants

Each invariant carries its reason. Work items cite them by number.

1. **Every card can be dismissed without a verdict.** Reason: forced choices cause decision fatigue, and fatigue ends the session.
2. **Every choice can be undone.** Reason: fast sorting is only safe when a wrong call is cheap to fix.
3. **A title is on at most one list, and a title on a list never returns to the deck.** Reason: the deck respects decisions you already made.
4. **Sorting a card takes one tap.** Reason: speed is the core feeling.
5. **The card shows the IMDb rating.** Reason: it is the score Alex trusts when deciding.
6. **Ratings and reviews live in Potato and belong to the user.** Reason: the record is personal, and it is the user's to keep, edit, and take elsewhere.
7. **Anything you can do in the app, your AI can do through Potato's AI connection, including writes.** Reason: Alex often talks a movie over with an AI after watching it, and the review comes out of that conversation.
8. **The app opens on the deck.** Reason: sorting cards is the core loop, and a home-screen app is ready the moment it opens.
9. **Nothing built now blocks the social direction.** Reason: social is the long-term endgame (see Possibility space).

## Non-goals for the first version

- Social features of any kind.
- Swipe gestures. The first version uses buttons.
- A native mobile app.
- A box office discovery mode.
- Commercial use (see Constraints).

## Constraints

- **Non-commercial.** The movie data, the IMDb ratings, and the hosting are all free on terms that allow personal, non-commercial use only. Charging money for Potato requires different data licenses and a different hosting plan.
- **Attribution.** The data providers require credit inside the app: TMDB for movie data, JustWatch for streaming availability, and IMDb for its ratings. The credits are mandatory, not decoration.

# Possibility space

Nothing in this part is built or committed. When it is time for one of these, it becomes a work item. Until then it is a direction, not a plan.

- **Social.** Profiles other people can see, friends, following other people's ratings and reviews, maybe a feed of what friends are watching. This is the long-term endgame.
- **Swipe gestures.** Left to pass and right to watchlist, alongside or instead of the buttons, once real use shows how the buttons feel.
- **A native mobile app,** with the web app as its spec.
- **Richer onboarding.** A first run that asks for favorite genres or has you rate a few favorites, so "for you" works sooner.
- **Smarter "for you."** The first version can be simple. It could grow into a real taste model.
- **A box office mode.** Dropped for the first version because Alex does not care about it, but it could return.
- **Per-season ratings** for series.

# Open tensions

- **Personal taste versus discovery.** "For you" pulls toward what you already like. "Deep cuts" pushes outward. How the default blend weighs the two is not settled.
- **The IMDb rating versus a commercial future.** Invariant 5 depends on IMDb data that is licensed for non-commercial use only. If Potato ever charges money, the rating needs a new source or the invariant needs revisiting.
- **The crowded bottom edge.** Four card buttons and a tab bar share the bottom of the screen. Real use decides whether this works or needs a different layout.
- **How long a skipped card stays away.** "After a while" is not pinned down.
