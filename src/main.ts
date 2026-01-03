/* eslint-disable import/no-nodejs-modules */
// cSpell:ignore unmatch 关键字
import {Notice, Plugin, TAbstractFile, TFile, TFolder, FileSystemAdapter, normalizePath} from "obsidian";
import {DEFAULT_SETTINGS, MyGitEnhancedPluginSettings, MyGitEnhancedSettingTab} from "./settings";
import {execFile} from "child_process";
import {promisify} from "util";
import {join} from "path";
import {access} from "fs/promises";
import {constants as fsConstants, rm} from "fs";

const execFileAsync = promisify(execFile);

export default class MyGitEnhancedPlugin extends Plugin {
  settings: MyGitEnhancedPluginSettings;
  // 串行处理重命名事件，避免 git 命令互相抢占。
  private renameQueue: Promise<void> = Promise.resolve();

  /**
   * 插件加载时注册设置面板与重命名监听。
   */
  async onload() {
    this.settings = await this.loadSettings();
    this.addSettingTab(new MyGitEnhancedSettingTab(this.app, this));

    // 开启重命名监听，事后用 git rm/add 修正索引。
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (!(file instanceof TFile) && !(file instanceof TFolder)) {
          return;
        }

        const newPath = file.path;
        if (oldPath === newPath) {
          return;
        }
        
        console.debug("obsidian-git-enhanced: 新旧路径", {oldPath: normalizePath(oldPath), newPath: normalizePath(newPath)});

        this.renameQueue = this.renameQueue
          .then(() => this.fixRenameWithGit(oldPath, newPath, file instanceof TFolder))
          .catch((error) => {
            console.error("obsidian-git-enhanced: Git 暂存重命名失败", error);
            new Notice("Git 暂存重命名失败，请查看控制台日志。");
          });
      })
    );
  }

  onunload() {}

  /**
   * 读取持久化设置。
   * @returns 合并默认值后的设置对象。
   */
  private async loadSettings(): Promise<MyGitEnhancedPluginSettings> {
    const stored = await this.loadData();
    if (stored && typeof stored === "object") {
      return Object.assign({}, DEFAULT_SETTINGS, stored as Partial<MyGitEnhancedPluginSettings>);
    }
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  /**
   * 保存当前设置。
   * @returns Promise<void>
   */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 使用 git rm --cached + git add 修正索引，让 Git 自动识别重命名。
   * @param oldPath 重命名前的路径。
   * @param newPath 重命名后的路径。
   * @param isFolder 是否为文件夹。
   */
  private async fixRenameWithGit(oldPath: string, newPath: string, isFolder: boolean): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return;
    }

    const vaultPath = adapter.getBasePath();
    const gitDir = join(vaultPath, ".git");
    if (!(await this.pathExists(gitDir))) {
      return;
    }

    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    const newAbsolutePath = join(vaultPath, normalizedNew);
    if (!(await this.pathExists(newAbsolutePath))) {
      return;
    }
    if (!(await this.isTrackedPath(vaultPath, normalizedOld))) {
      return;
    }

    const rmArgs = isFolder
      ? ["rm", "--cached", "-r", "--", normalizedOld]
      : ["rm", "--cached", "--", normalizedOld];

    console.debug("obsidian-git-enhanced: git rm 参数", {rmArgs});
    await this.runGitCommand(vaultPath, rmArgs);
    await this.runGitCommand(vaultPath, ["add", "--", normalizedNew]);
  }

  /**
   * 判断给定路径是否存在。
   * @param path 绝对路径。
   * @returns 是否存在。
   */
  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 判断路径是否已被 Git 跟踪。
   * @param cwd 仓库根目录。
   * @param relativePath 相对路径。
   * @returns 是否已跟踪。
   */
  private async isTrackedPath(cwd: string, relativePath: string): Promise<boolean> {
    try {
      await this.runGitCommand(cwd, ["ls-files", "--error-unmatch", "--", relativePath]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 运行 Git 命令。
   * @param cwd 仓库根目录。
   * @param args Git 参数列表。
   */
  private async runGitCommand(cwd: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, {cwd});
  }
}
