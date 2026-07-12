# Third-Party Notices

This package adapts compatible, fixture-proven behavior from:

- Project: `luogu-mcp-server`
- Repository: <https://github.com/Kaiserunix/luogu-mcp-server>
- Audited version: `0.2.1`
- Audited commit: `9d3f5bc47647620ea2f8566e2be65bdf5cc2ca3b`
- License: MIT
- Copyright: Copyright (c) 2026 Kaiserunix

The adapted behavior is limited to the anonymous content-only problem-list and
problem-page endpoint construction, the `x-lentille-request: content-only`
request convention, the `title`/`name` and `content`/`contenu` compatibility
fallbacks, array/object sample normalization, and the stateless Web Standard
Streamable HTTP transport shape. The implementation in this package was
rewritten around the shared OJ schemas, bounded Zod validation, typed errors,
fixed-origin policy, and a four-tool public-read surface.

The upstream MIT license follows.

> MIT License
>
> Copyright (c) 2026 Kaiserunix
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
