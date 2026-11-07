// Shared fixtures for TMDB tests: a scripted fetch that never touches the
// network, and trimmed copies of real TMDB payloads.

export interface RecordedCall {
  url: string;
  path: string;
  params: URLSearchParams;
  authorization: string | null;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

/**
 * A fetch that answers from `routes` (keyed by path without the query) and
 * records every call. Each route may be one responder or a queue of them,
 * consumed in order (the last one repeats). Unknown paths fail the test.
 */
export function scriptedFetch(routes: Record<string, Responder | Responder[]>) {
  const calls: RecordedCall[] = [];
  const counters = new Map<string, number>();
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.host !== "api.themoviedb.org") throw new Error(`unexpected host ${url.host}`);
    const path = url.pathname.replace(/^\/3/, "");
    const headers = new Headers(init?.headers);
    const call = { url: input, path, params: url.searchParams, authorization: headers.get("authorization") };
    calls.push(call);
    const route = routes[path];
    if (!route) throw new Error(`no scripted response for ${path}`);
    const queue = Array.isArray(route) ? route : [route];
    const n = counters.get(path) ?? 0;
    counters.set(path, n + 1);
    return queue[Math.min(n, queue.length - 1)](call);
  };
  return { fetch: fetchFn, calls };
}

export const json = (body: unknown, init: ResponseInit = {}) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

export const status = (code: number, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify({ success: false, status_code: code }), { status: code, headers });

export const notFound = () =>
  new Response(JSON.stringify({ success: false, status_code: 34, status_message: "The resource you requested could not be found." }), {
    status: 404,
  });

export const matrixProviders = {
  results: {
    US: {
      link: "https://www.themoviedb.org/movie/603-the-matrix/watch?locale=US",
      flatrate: [{ logo_path: "/yt.png", provider_id: 2528, provider_name: "YouTube TV", display_priority: 41 }],
      rent: [
        { logo_path: "/apple.png", provider_id: 2, provider_name: "Apple TV Store", display_priority: 10 },
        { logo_path: "/amazon.png", provider_id: 10, provider_name: "Amazon Video", display_priority: 9 },
      ],
      buy: [{ logo_path: "/amazon.png", provider_id: 10, provider_name: "Amazon Video", display_priority: 9 }],
    },
    GB: { link: "https://example.test/gb", flatrate: [{ provider_id: 8, provider_name: "Netflix", logo_path: "/n.png", display_priority: 1 }] },
  },
};

/** /movie/603 with external_ids, videos, and watch/providers appended (trimmed). */
export const matrixDetails = {
  adult: false,
  genres: [
    { id: 28, name: "Action" },
    { id: 878, name: "Science Fiction" },
  ],
  id: 603,
  imdb_id: "tt0133093",
  overview: "Set in the 22nd century, The Matrix tells the story of a computer hacker...",
  popularity: 20.1,
  poster_path: "/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg",
  release_date: "1999-03-31",
  runtime: 136,
  title: "The Matrix",
  vote_average: 8.2,
  vote_count: 27000,
  external_ids: { imdb_id: "tt0133093", wikidata_id: "Q83495" },
  videos: {
    results: [
      { site: "YouTube", key: "featurette1", type: "Featurette", official: true, iso_639_1: "en", published_at: "2026-07-10T19:00:28.000Z" },
      { site: "YouTube", key: "anniv3", type: "Trailer", official: true, iso_639_1: "en", published_at: "2024-09-17T17:49:33.000Z" },
      { site: "YouTube", key: "spot", type: "Teaser", official: true, iso_639_1: "en", published_at: "2024-08-13T15:00:21.000Z" },
      { site: "YouTube", key: "anniv1", type: "Trailer", official: true, iso_639_1: "en", published_at: "2024-04-26T11:43:36.000Z" },
      { site: "Vimeo", key: "vimeo-old", type: "Trailer", official: true, iso_639_1: "en", published_at: "1999-01-01T00:00:00.000Z" },
    ],
  },
  "watch/providers": matrixProviders,
};

/** /tv/1396 with appends (trimmed). */
export const breakingBadDetails = {
  id: 1396,
  name: "Breaking Bad",
  first_air_date: "2008-01-20",
  genres: [
    { id: 18, name: "Drama" },
    { id: 80, name: "Crime" },
  ],
  number_of_seasons: 5,
  episode_run_time: [],
  overview: "Walter White, a chemistry teacher...",
  popularity: 60.5,
  poster_path: "/ggFHVNu6YYI5L9pCfOacjizRGt.jpg",
  vote_average: 8.9,
  vote_count: 16000,
  external_ids: { imdb_id: "tt0903747", tvdb_id: 81189 },
  videos: { results: [{ site: "YouTube", key: "bbTeaser", type: "Teaser", official: false, iso_639_1: "en", published_at: "2008-01-01T00:00:00.000Z" }] },
  "watch/providers": { results: { US: { link: "https://example.test/bb", flatrate: [{ provider_id: 8, provider_name: "Netflix", logo_path: "/n.png", display_priority: 0 }] } } },
};
