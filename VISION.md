# Potato: vision

This file describes what Potato is and how it should feel to use. It holds no implementation details. When a build decision is unclear, check it against this file. It changes rarely.

## What Potato is

Potato is a way to decide what to watch, one title at a time. It shows you a movie or TV series as a card. You make a quick call on it, and it moves you to the next one. Over time your calls build into a watchlist, a record of what you passed on, and a record of what you have seen, with your ratings and reviews.

The core feeling is speed without pressure. Sorting a card should take a few seconds. You never have to give a verdict you are not ready to give.

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

Four buttons sit at the bottom of the screen, always visible while you scroll the card:

1. **Pass.** You don't want to watch it. It goes to your Passed list.
2. **Skip.** You are not ready to decide. It goes to no list, and it comes back to the deck after a while.
3. **Watchlist.** You want to watch it. It goes to your Watchlist.
4. **Seen it.** You have already watched it. You rate it, and you can write a review if you want to. It goes to your Seen list.

A title you have put on a list never comes back to the deck. The first version uses buttons. Swipe gestures may replace or join them after real use.

## Ratings and reviews

A rating is 1 to 5 stars, in half-star steps. A review is free text and is optional. A series gets one rating and one review for the whole show, not one per season or episode. Ratings and reviews belong to your profile and live inside Potato.

## Your lists

You have three lists: Watchlist, Passed, and Seen. Every choice can be undone:

- A Watchlist title can be marked as seen, which asks for a rating and moves it to Seen.
- A Passed title can move to the Watchlist if you change your mind.
- A rating or review can be edited at any time.

The same filters that shape the deck (below) also work on each list.

## Search

You can search for any title at any time. A search result opens the same card you see in the deck, with the same four buttons. This covers two common moments: you saw a trailer somewhere and want to add the title to your Watchlist, or you just finished something and want to rate it.

## Shaping the deck

Two controls shape what the deck shows you.

**Filters** decide which titles can appear:

- movie or series
- genre
- era (for example, recent releases only)
- available on my streaming services

**Discovery mode** decides the order the titles come in:

- popular
- deep cuts (good titles fewer people know)
- top rated
- for you (based on your own ratings)

The default mode is a blend of these. "For you" needs ratings to work. Until you have rated enough titles, choosing "For you" shows an empty state that asks you to rate more titles to unlock it.

The example to design for: "I want a good modern sci-fi series on something I already pay for." Filters plus a mode should get you there in a few taps.

## Navigation

The app opens directly on the deck, because sorting cards is the core loop and a home-screen app should be ready the moment it opens.

A tab bar along the bottom of the screen holds the main places:

- **Discover:** the deck, with its filter and mode controls
- **Search**
- **Lists:** Watchlist, Seen, and Passed
- **Profile:** your settings and account

The four card buttons sit just above the tab bar. Both rows are within thumb reach on a phone.

## Your account and settings

You sign in with Google. Everything you do is saved to your profile and follows you across devices.

Settings hold your country and the streaming services you use. These drive the streaming info on each card and the "on my services" filter.

## Your data and your AI

Your lists, ratings, and reviews are yours, and you can connect them to the AI assistant of your choice. Anything you can do in the app, your AI can do too, including writing to your account, not only reading it.

The example to design for: you talk about a movie you just watched with your AI, then say "turn what I said into a review, I'd give it 4/5." The review appears in your Seen list, the same as if you had written it in the app.

## How it should feel

Potato runs as a web app saved to the iPhone home screen. It should feel like a native app: fast, one-handed, no visible page loads, and nothing that looks like a website.

## Long-term direction

These are not part of the first version. Nothing built now should make them hard to add later.

- **Social.** Friends, profiles other people can see, following other people's ratings and reviews. This is the long-term endgame.
- **A native mobile app.** The web app serves as the spec for it.
