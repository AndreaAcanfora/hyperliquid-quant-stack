import type { NextConfig } from 'next';

const config: NextConfig = {
  // The strategy package ships ESM sources from the workspace.
  transpilePackages: ['@andreaaca/trend-ensemble'],
};

export default config;
