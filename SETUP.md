# 上线说明（给 Felix）

这套文件抄自 H-Chris233 的主页结构，文字全部换成你的全英文版本。要让它显示在
`github.com/Felix201209` 的个人主页上，**仓库名必须正好等于你的用户名 `Felix201209`**。

> ⚠️ 你现在的 `Felix201209/H-Chris233`（fork）不会显示在主页——名字不对。需要一个叫
> `Felix201209` 的新仓库（即 `Felix201209/Felix201209`）。

## 步骤

1. 在 GitHub 新建一个 **Public** 仓库，名字填 `Felix201209`（GitHub 会提示这是 special
   profile repo，并显示一个 ✨ 彩蛋）。先不要勾选 “Add a README”。

2. 在本文件夹里 push 上去（默认分支用 `main`）：
   ```bash
   cd ~/Desktop/Felix201209-profile
   git init -b main
   git add .
   git commit -m "feat: profile readme"
   git remote add origin https://github.com/Felix201209/Felix201209.git
   git push -u origin main
   ```

3. push 后 GitHub Actions 会自动跑两个工作流：
   - `Update README cards` → 生成 `profile/stats.svg` 和 `profile/top-langs.svg`
   - `generate animation` → 把贪吃蛇推到 `output` 分支

   首次也可以手动触发：仓库 → **Actions** → 选中工作流 → **Run workflow**。

4. 等工作流绿了，打开 `https://github.com/Felix201209` 就能看到主页。

## 说明 / 可调项

- **统计卡刚开始是空白**：`profile/*.svg` 要等第一次工作流跑完才生成，属正常。
- **统计卡主题**：在 `.github/workflows/readme-stats-action.yml` 里改 `theme`、`title_color`
  等（现在沿用 Chris 的 `swift` 主题 + 粉色强调色，你可以换）。
- **访客计数器**：README 顶部那行用的是 count.getloli.com，`@Felix201209's+counter` 是你
  独立的计数命名，无需配置。
- **技术栈徽章**：我按你的真实栈填了 13 个（TS/JS/Node/React/Electron/Vite/Python/
  Cloudflare/树莓派/Linux/Git/Claude/OpenAI），多了少了直接在 README 里加删 `img.shields.io` 那几行。
- **项目列表 / Fun Fact**：`AutoDirector`、`AT Group Chat` 是按你的项目写的，想换/删/加自己改。
- 如果你的默认分支用 `master` 而不是 `main`，把两个 yml 里的 `branches: - main` 改成 `master`。
