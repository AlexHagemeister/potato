// The Twitter/X card image: the same picture as the Open Graph image.
// Next reads alt, size, and contentType from this file, so they are restated.
import OpenGraphImage, { alt as ogAlt, contentType as ogContentType, size as ogSize } from "./opengraph-image";

export const alt = ogAlt;
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return OpenGraphImage();
}
