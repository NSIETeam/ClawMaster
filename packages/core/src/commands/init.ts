/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandActionReturn } from './types.js';

/**
 * `/init` — ask the agent to analyze the current directory and generate a
 * project memory file. ClawMaster uses `CLAWMASTER.md`; callers may still
 * report an existing legacy context file to avoid creating duplicates.
 */
export function performInit(doesMemoryFileExist: boolean): CommandActionReturn {
  if (doesMemoryFileExist) {
    return {
      type: 'message',
      messageType: 'info',
      content:
        'A ClawMaster project memory file already exists in this directory. No changes were made.',
    };
  }
  return {
    type: 'submit_prompt',
    content: `
You are an AI agent that brings the power of ClawMaster directly into the terminal. Your task is to analyze the current directory and generate a comprehensive CLAWMASTER.md file to be used as instructional context for future interactions.

**Analysis Process:**

1.  **Initial Exploration:**
    *   Start by listing the files and directories to get a high-level overview of the structure.
    *   Read the README file (e.g., \`README.md\`, \`README.txt\`) if it exists.

2.  **Iterative Deep Dive (up to 10 files):**
    *   Select a few files that seem most important (e.g. config, main source, docs).
    *   Read them and let your discoveries guide further exploration.

3.  **Identify Project Type:**
    *   **Code Project:** Look for \`package.json\`, \`requirements.txt\`, \`pom.xml\`, \`go.mod\`, \`Cargo.toml\`, a \`src\` directory, etc.
    *   **Non-Code Project:** Documentation, research, notes, etc.

**CLAWMASTER.md Content Generation:**

**For a Code Project:**
*   **Project Overview:** Purpose, main technologies, architecture.
*   **Building and Running:** Key build / run / test commands.
*   **Development Conventions:** Coding styles, testing practices, contribution guidelines.

**For a Non-Code Project:**
*   **Directory Overview:** Purpose and contents.
*   **Key Files:** Important files with brief explanation.
*   **Usage:** How the contents are intended to be used.

**Final Output:**

Write the complete content to the \`CLAWMASTER.md\` file. The output must be well-formatted Markdown.
`,
  };
}
