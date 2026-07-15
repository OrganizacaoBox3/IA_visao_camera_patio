/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CP_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
