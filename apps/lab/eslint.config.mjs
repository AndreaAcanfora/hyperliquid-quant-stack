import next from 'eslint-config-next';

const config = [...next, { ignores: ['.next/**', 'public/data/**'] }];

export default config;
