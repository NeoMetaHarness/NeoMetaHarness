# Third-party notices

Neo Meta Harness builds on these projects. Engines are used unmodified as separate programs; adopted code keeps its license notice here.

| Project | License | How it is used |
|---|---|---|
| [bot-hq](https://github.com/nickvasilescu/bot-hq) | MIT | **Adopted**: domain code derived into `packages/agents` from commit `decf9a215cdd` (see `packages/agents/PORTING.md`); license below |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | Engine (unmodified) |
| [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | MIT | Engine bundle (unmodified) |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | MIT | Engine (unmodified) |
| [T3 Code](https://github.com/pingdotgg/t3code) | MIT | Engine (server) + headless client packages (unmodified) |
| [Honcho](https://github.com/plastic-labs/honcho) | see upstream | Memory service (unmodified) |
| [Panda Router](https://github.com/aicodeking/PandaOrchestrator) | MIT | Model router process (unmodified) |
| [Astryx](https://github.com/meta/astryx) | MIT | Design system (npm dependency) |
| [uv](https://github.com/astral-sh/uv) | MIT OR Apache-2.0 | Unmodified release binary bundled with the desktop installers (version and checksums in `scripts/installer-tools.json`); builds the Hermes Python environment when Hermes is installed from the app |
| [Compose Specification](https://github.com/compose-spec/compose-spec) | MIT | Unmodified offline JSON Schema at commit `6b3a2a93e77c30ded1aa8264307e74d1208a6eae`; [license](deploy/schema/LICENSE) and [provenance](deploy/schema/README.md) |

## bot-hq license (verbatim, commit decf9a215cdd)

```
MIT License

Copyright (c) 2026 Nick Vasilescu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
