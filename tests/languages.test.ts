import { describe, it, expect } from 'vitest';
import { mapCodeLanguage, CODE_LANGUAGE } from '../src/convert/languages.js';

describe('mapCodeLanguage', () => {
  it('常见语言与别名', () => {
    expect(mapCodeLanguage('ts')).toBe(CODE_LANGUAGE.TypeScript);
    expect(mapCodeLanguage('typescript')).toBe(CODE_LANGUAGE.TypeScript);
    expect(mapCodeLanguage('js')).toBe(CODE_LANGUAGE.JavaScript);
    expect(mapCodeLanguage('jsx')).toBe(CODE_LANGUAGE.JavaScript);
    expect(mapCodeLanguage('py')).toBe(CODE_LANGUAGE.Python);
    expect(mapCodeLanguage('bash')).toBe(CODE_LANGUAGE.Bash);
    expect(mapCodeLanguage('sh')).toBe(CODE_LANGUAGE.Bash);
    expect(mapCodeLanguage('shell')).toBe(CODE_LANGUAGE.Shell);
    expect(mapCodeLanguage('cpp')).toBe(CODE_LANGUAGE['C++']);
    expect(mapCodeLanguage('c++')).toBe(CODE_LANGUAGE['C++']);
    expect(mapCodeLanguage('cs')).toBe(CODE_LANGUAGE.CSharp);
    expect(mapCodeLanguage('yml')).toBe(CODE_LANGUAGE.YAML);
    expect(mapCodeLanguage('tex')).toBe(CODE_LANGUAGE.LateX);
    expect(mapCodeLanguage('md')).toBe(CODE_LANGUAGE.Markdown);
    expect(mapCodeLanguage('dockerfile')).toBe(CODE_LANGUAGE.Dockerfile);
    expect(mapCodeLanguage('')).toBe(CODE_LANGUAGE.PlainText);
  });

  it('大小写不敏感与原始枚举名', () => {
    expect(mapCodeLanguage('Python')).toBe(CODE_LANGUAGE.Python);
    expect(mapCodeLanguage('GraphQL')).toBe(CODE_LANGUAGE.GraphQL);
  });

  it('飞书不支持的语言返回 null', () => {
    expect(mapCodeLanguage('mermaid')).toBeNull();
    expect(mapCodeLanguage('notalang')).toBeNull();
  });
});
