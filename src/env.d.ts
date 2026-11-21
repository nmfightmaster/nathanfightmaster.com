interface ImportMetaEnv {
  /** PDF-only phone number, set in the build environment. Never committed. */
  readonly RESUME_PHONE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
