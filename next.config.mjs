/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for SharedArrayBuffer used by ONNX WASM multi-threading
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },

  webpack: (config, { isServer }) => {
    // Enable async WASM modules (required by onnxruntime-web)
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

    // Suppress node-only deps from browser bundle
    config.resolve.alias = {
      ...config.resolve.alias,
      "onnxruntime-node$": false,
      sharp$: false,
    };

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }

    return config;
  },
};

export default nextConfig;
