import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      'no-restricted-properties': ['error',
        { object: 'window', property: 'alert', message: 'AccessibleModal 기반 알림을 사용하세요.' },
        { object: 'window', property: 'confirm', message: 'AccessibleModal 기반 확인창을 사용하세요.' },
        { object: 'window', property: 'prompt', message: 'AccessibleModal 기반 입력폼을 사용하세요.' },
        { object: 'globalThis', property: 'alert', message: 'AccessibleModal 기반 알림을 사용하세요.' },
        { object: 'globalThis', property: 'confirm', message: 'AccessibleModal 기반 확인창을 사용하세요.' },
        { object: 'globalThis', property: 'prompt', message: 'AccessibleModal 기반 입력폼을 사용하세요.' },
      ],
      'no-restricted-globals': ['error',
        { name: 'alert', message: 'AccessibleModal 기반 알림을 사용하세요.' },
        { name: 'confirm', message: 'AccessibleModal 기반 확인창을 사용하세요.' },
        { name: 'prompt', message: 'AccessibleModal 기반 입력폼을 사용하세요.' },
      ],
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);

export default eslintConfig;
