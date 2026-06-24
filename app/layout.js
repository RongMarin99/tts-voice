import "./globals.css";

export const metadata = {
  title: "TTS Voice — Natural Text to Speech",
  description: "Unlimited, free, natural text-to-speech with download. Runs locally in your browser.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
