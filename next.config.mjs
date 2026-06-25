/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",

  webpack: (config, { isServer }) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

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
