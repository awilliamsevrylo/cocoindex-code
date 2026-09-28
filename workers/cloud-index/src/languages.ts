/**
 * Language detection mapping by file extension.
 */

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  markdown: "markdown",
  rst: "restructuredtext",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  html: "html",
  css: "css",
  sql: "sql",
  txt: "text",
};

export function detectLanguage(path: string): string {
  const parts = path.split(".");
  if (parts.length > 1) {
    const ext = parts[parts.length - 1].toLowerCase();
    if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  }
  return "text";
}
