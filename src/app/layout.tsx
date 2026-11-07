import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SessionRefresher } from "./session-refresher";

export const metadata: Metadata = {
  title: "Potato",
  description: "Decide what to watch, one card at a time.",
  appleWebApp: {
    capable: true,
    title: "Potato",
    statusBarStyle: "black-translucent",
  },
  // Next.js emits only the unprefixed mobile-web-app-capable tag for
  // appleWebApp.capable. Older iOS versions read only the apple- prefixed one.
  other: { "apple-mobile-web-app-capable": "yes" },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0b0c",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body>
        <SessionRefresher />
        {children}
      </body>
    </html>
  );
}
