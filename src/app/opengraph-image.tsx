import { ImageResponse } from "next/og";
import { CHOICES, TAGLINE } from "./(app)/_landing/copy";

// The link preview image (Open Graph; twitter-image.tsx reuses it). Drawn in
// code at build time from the landing page's words and colors: no poster, no
// TMDB or IMDb data, no network call. ImageResponse lays out with flexbox only,
// so every box with more than one child sets display: flex.

export const alt = `Potato. ${TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0b0b0c";
const FG = "#ededed";
const MUTED = "#8e8e93";
const SURFACE = "#161618";
const RAISED = "#1f1f22";
const HAIRLINE = "#2a2a2e";
const ACCENT = "#f5c451";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 96px",
          background: BG,
          color: FG,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", width: 640 }}>
          <div style={{ fontSize: 112, fontWeight: 700, letterSpacing: -3, lineHeight: 1 }}>Potato</div>
          <div style={{ marginTop: 28, fontSize: 46, fontWeight: 600, lineHeight: 1.2, letterSpacing: -0.5 }}>
            {TAGLINE}
          </div>
          <div style={{ display: "flex", marginTop: 44, gap: 14 }}>
            {CHOICES.map((c) => (
              <div
                key={c.kind}
                style={{
                  display: "flex",
                  padding: "12px 22px",
                  borderRadius: 999,
                  background: RAISED,
                  border: `2px solid ${HAIRLINE}`,
                  color: c.kind === "watchlist" ? ACCENT : FG,
                  fontSize: 28,
                  fontWeight: 600,
                }}
              >
                {c.label}
              </div>
            ))}
          </div>
        </div>

        {/* An example card: a drawn dusk poster over a stack of two more cards. */}
        <div style={{ display: "flex", position: "relative", width: 300, height: 470 }}>
          <div
            style={{
              position: "absolute",
              top: 14,
              left: 22,
              width: 300,
              height: 470,
              borderRadius: 36,
              background: RAISED,
              border: `2px solid ${HAIRLINE}`,
              transform: "rotate(6deg)",
            }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              position: "absolute",
              top: 0,
              left: 0,
              width: 300,
              height: 470,
              padding: 14,
              borderRadius: 36,
              background: SURFACE,
              border: `2px solid ${HAIRLINE}`,
            }}
          >
            <div
              style={{
                display: "flex",
                position: "relative",
                width: 268,
                height: 340,
                borderRadius: 24,
                overflow: "hidden",
                background: "linear-gradient(180deg, #14163a 0%, #4b2a6b 42%, #c8566a 70%, #f3a25a 78%, #2a1838 78%, #0b0b0c 100%)",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 94,
                  top: 186,
                  width: 80,
                  height: 80,
                  borderRadius: 999,
                  background: ACCENT,
                  boxShadow: `0 0 60px 20px rgba(245, 196, 81, 0.45)`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 265,
                  width: 268,
                  height: 75,
                  background: "linear-gradient(180deg, #2a1838 0%, #0b0b0c 100%)",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              {CHOICES.map((c) => (
                <div
                  key={c.kind}
                  style={{
                    display: "flex",
                    width: 59,
                    height: 70,
                    borderRadius: 18,
                    background: RAISED,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 999,
                      background: c.kind === "watchlist" ? ACCENT : MUTED,
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
