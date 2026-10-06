/** 不依赖原生 esbuild：用 typescript 转译 + require hook 直接跑 TS 验证脚本。 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const ts = require('typescript')

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
  esModuleInterop: true,
  resolveJsonModule: true,
  strict: false,
  skipLibCheck: true,
}

const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@/')) {
    request = path.resolve(__dirname, '..', 'src', request.slice(2))
  }
  return originalResolveFilename.call(this, request, parent, ...rest)
}

require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const result = ts.transpileModule(source, { compilerOptions, fileName: filename })
  module._compile(result.outputText, filename)
}

require(path.join(__dirname, 'verify-drainage.ts'))
