import next from 'eslint-config-next';

const config = [...next, { ignores: ['.next/**', 'data/**', 'test-results/**', 'playwright-report/**'] }];

export default config;
