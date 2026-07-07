import '@testing-library/jest-dom/vitest'

// jsdom's Blob/File implementation doesn't provide .text()/.arrayBuffer()
// (real browsers and Node's own Blob do) — polyfill via FileReader, which
// jsdom does implement, so upload-parsing tests can exercise the same File
// API surface the app actually calls in production.
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error as DOMException)
      reader.readAsArrayBuffer(this)
    })
  }
}

if (typeof Blob !== 'undefined' && !Blob.prototype.text) {
  Blob.prototype.text = function (): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error as DOMException)
      reader.readAsText(this)
    })
  }
}
