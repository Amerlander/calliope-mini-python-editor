/**
 * (c) 2021 - 2022, Micro:bit Educational Foundation and contributors
 *
 * SPDX-License-Identifier: MIT
 */
import { waitFor, waitForOptions } from "@testing-library/dom";
import { Matcher } from "@testing-library/react";
import * as fs from "fs";
import * as fsp from "fs/promises";
import { escapeRegExp } from "lodash";
import * as os from "os";
import * as path from "path";
import "pptr-testing-library/extend";
import puppeteer, { Browser, Dialog, ElementHandle, Page } from "puppeteer";
import { WebUSBErrorCode } from "../device/device";
import { Flag } from "../flags";

export enum LoadDialogType {
  CONFIRM,
  REPLACE,
  CONFIRM_BUT_LOAD_AS_MODULE,
  NONE,
}

export interface BrowserDownload {
  filename: string;
  data: Buffer;
}

const defaultWaitForOptions = { timeout: 5_000 };

const baseUrl = "http://localhost:3000";
const reportsPath = "reports/e2e/";

interface Options {
  /**
   * Flags.
   *
   * "none" and "noWelcome" are always added.
   *
   * Do not use "*", instead explicitly enable the set of flags your test requires.
   */
  flags?: Flag[];
  /**
   * URL fragment including the #.
   */
  fragment?: string;
  /**
   * Language parameter passed via URL.
   */
  language?: string;
}

/**
 * Model of the app to drive it for e2e testing.
 *
 * We could split this into screen areas accessible from this class.
 *
 * All methods should ensure they wait for a condition rather than relying on timing.
 *
 * Generally this means it's better to pass in expected values, so you can wait for
 * them to be true, than to read and return data from the DOM.
 */
export class App {
  private url: string;
  /**
   * Tracks dialogs observed by Pupeteer's dialog event.
   */
  private dialogs: string[] = [];
  private browser: Promise<Browser>;
  private page: Promise<Page>;
  private downloadPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "puppeteer-downloads-")
  );

  constructor(options: Options = {}) {
    this.url = this.optionsToURL(options);
    this.browser = puppeteer.launch({
      headless: process.env.E2E_HEADLESS !== "0",
      // Needs to be large enough to display Reference + Simulator or tests need to show/hide them.
      defaultViewport: { width: 1920, height: 1440 },
    });
    this.page = this.createPage();
  }

  setOptions(options: Options) {
    this.url = this.optionsToURL(options);
  }

  private optionsToURL(options: Options): string {
    const flags = new Set<string>([
      "none",
      "noWelcome",
      ...(options.flags ?? []),
    ]);
    const params: Array<[string, string]> = Array.from(flags).map((f) => [
      "flag",
      f,
    ]);
    if (options.language) {
      params.push(["l", options.language]);
    }
    return (
      baseUrl +
      // We don't use PUBLIC_URL here as CRA seems to set it to "" before running jest.
      (process.env.E2E_PUBLIC_URL ?? "/") +
      "?" +
      new URLSearchParams(params) +
      (options.fragment ?? "")
    );
  }

  async createPage() {
    const browser = await this.browser;
    const context = browser.defaultBrowserContext();
    const { origin } = new URL(this.url);
    await context.overridePermissions(origin, [
      "clipboard-read",
      "clipboard-write",
    ]);

    const page = await context.newPage();
    await page.setCookie({
      // See corresponding code in App.tsx.
      name: "mockDevice",
      value: "1",
      url: this.url,
    });
    // Don't show compliance notice.
    await page.setCookie({
      name: "MBCC",
      value: "1",
      url: this.url,
    });

    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: this.downloadPath,
    });

    this.dialogs.length = 0;
    page.on("dialog", async (dialog: Dialog) => {
      this.dialogs.push(dialog.type());
      // Need to accept() so that reload() will complete.
      await dialog.accept();
    });

    const logsPath = this.reportFilename("txt");
    // Clears previous output from local file.
    fs.writeFile(logsPath, "", (err) => {
      if (err) {
        // Log file error.
        console.error("Log file error: ", err.message);
      }
    });
    page.on("console", (msg) => {
      fs.appendFile(logsPath, msg.text() + "\n", (err) => {
        if (err) {
          // Log file error.
          console.error("Log file error: ", err.message);
        }
      });
    });

    await page.evaluate(() => {
      if (document.domain === "localhost") {
        window.localStorage.clear();
      }
    });

    return page;
  }

  /**
   * Close the page, accepting any native dialogs (e.g. beforeunload).
   *
   * @returns a boolean representing whether a "beforeunload" dialog is raised.
   */
  async closePageCheckDialog(): Promise<boolean> {
    const page = await this.page;
    await page.close({
      runBeforeUnload: true,
    });
    // A delay is required to give us a chance to handle the dialog event.
    // If this proves fragile we could wait for the success condition below
    // and give up on testing the absence of a dialog.
    await page.waitForTimeout(50);
    return this.dialogs.length === 1 && this.dialogs[0] === "beforeunload";
  }

  /**
   * Reload the page, accepting any native dialogs (e.g. beforeunload).
   */
  async reloadPage(): Promise<void> {
    const page = await this.page;
    await page.reload();
  }

  /**
   * Open a file using the file chooser.
   *
   * @param filePath The file on disk.
   * @param options Options to control expectations after upload.
   */
  async loadFiles(
    filePath: string,
    options: { acceptDialog?: LoadDialogType } = {}
  ): Promise<void> {
    await this.switchTab("Project");
    const document = await this.document();
    const openInput = await document.getAllByTestId("open-input");
    await openInput[0].uploadFile(filePath);
    if (options.acceptDialog !== undefined) {
      await this.findAndAcceptLoadDialog(options.acceptDialog);
    }
  }

  /**
   * Add a new file using the files tab.
   *
   * @param name The name to enter in the dialog.
   */
  async createNewFile(name: string): Promise<void> {
    await this.switchTab("Project");
    const document = await this.document();
    const createFileButton = await document.findByRole("button", {
      name: "Create file",
    });
    await createFileButton.click();
    const nameField = await document.findByRole("textbox", {
      name: "Name",
    });
    await nameField.type(name);
    const createButton = await document.findByRole("button", {
      name: "Create",
    });
    await createButton.click();
  }

  /**
   * Open a file using drag and drop.
   *
   * This is a bit fragile and likely to break if we change the DnD DOM as
   * we resort to simulating DnD events.
   *
   * @param filePath The file on disk.
   */
  async dropFile(
    filePath: string,
    options: { acceptDialog?: LoadDialogType } = {}
  ): Promise<void> {
    const page = await this.page;
    // Puppeteer doesn't have file drop support but we can use an input
    // to grab a file and trigger an event that's good enough.
    // It's a bit of a pain as the drop happens on an element created by
    // the drag-over.
    // https://github.com/puppeteer/puppeteer/issues/1376
    // This issue has since been fixed and we've upgraded, so there's an opportunity to simplify here.
    const inputId = "simulated-drop-input";
    await page.evaluate((inputId) => {
      const input = document.createElement("input");
      input.style.display = "none";
      input.type = "file";
      input.id = inputId;
      input.onchange = (e: any) => {
        const dragOverZone = document.querySelector(
          "[data-testid=project-drop-target]"
        );
        if (!dragOverZone) {
          throw new Error();
        }
        const dragOverEvent = new Event("dragover", {
          bubbles: true,
        });
        const dropEvent = new Event("drop", {
          bubbles: true,
        });
        (dragOverEvent as any).dataTransfer = { types: ["Files"] };
        (dropEvent as any).dataTransfer = { files: e.target.files };
        dragOverZone.dispatchEvent(dragOverEvent);

        const dropZone = document.querySelector(
          "[data-testid=project-drop-target-overlay]"
        );
        dropZone!.dispatchEvent(dropEvent);

        input.remove();
      };
      document.body.appendChild(input);
    }, inputId);
    const fileInput = await page.$(`#${inputId}`);
    await fileInput!.uploadFile(filePath);
    if (options.acceptDialog !== undefined) {
      await this.findAndAcceptLoadDialog(options.acceptDialog);
    }
  }

  private async findAndAcceptLoadDialog(dialogType: LoadDialogType) {
    if (dialogType === LoadDialogType.CONFIRM) {
      return this.findAndClickButton("Confirm");
    }
    if (dialogType === LoadDialogType.REPLACE) {
      return this.findAndClickButton("Replace");
    }
    if (dialogType === LoadDialogType.CONFIRM_BUT_LOAD_AS_MODULE) {
      // Use the Option menu to change how we load the file.
      await this.findAndClickButton("Options");
      const document = await this.document();
      const menuItem = await document.findByText(/^(Add|Replace) file .+\.py$/);
      await menuItem.click();

      return this.findAndClickButton("Confirm");
    }
  }

  private async findAndClickButton(name: string): Promise<void> {
    const document = await this.document();
    const button = await document.findByRole("button", {
      name: name,
    });
    await button.click();
  }

  async switchLanguage(locale: string): Promise<void> {
    // All test ids so they can be language invariant.
    const document = await this.document();
    await this.clickSettingsMenu();
    await (await document.findByTestId("language")).click();
    await (await document.findByTestId(locale)).click();
  }

  private async clickSettingsMenu(): Promise<void> {
    // All test ids for the sake of language-related tests.
    const document = await this.document();
    return (await document.findByTestId("settings")).click();
  }

  async findThirdPartyModuleWarning(
    expectedName: string,
    expectedVersion: string
  ): Promise<void> {
    const document = await this.document();
    await document.findByRole("gridcell", {
      name: expectedName,
    });
    await document.findByRole("gridcell", {
      name: expectedVersion,
    });
  }

  async toggleSettingThirdPartyModuleEditing(): Promise<void> {
    await this.clickSettingsMenu();
    const document = await this.document();
    const settings = await document.findByRole("menuitem", {
      name: "Settings",
    });
    await settings.click();
    const checkbox = await document.findByRole("checkbox", {
      name: "Allow editing third-party modules",
    });
    // Regular click() doesn't work here.
    await checkbox.evaluate((e) => (e as any).click());
    await this.findAndClickButton("Close");
  }

  /**
   * Use the Files sidebar to change the current file we're editing.
   *
   * @param filename The name of the file in the file list.
   */
  async switchToEditing(filename: string): Promise<void> {
    await this.openFileActionsMenu(filename);
    const document = await this.document();
    const editButton = await document.findByRole("menuitem", {
      name: "Edit " + filename,
    });
    await editButton.click();
  }

  /**
   * Can switch to editing a file.
   *
   * For now we only support editing Python files.
   *
   * @param filename The name of the file in the file list.
   */
  async canSwitchToEditing(filename: string): Promise<boolean> {
    await this.openFileActionsMenu(filename);
    const document = await this.document();
    const editButton = await document.findByRole("menuitem", {
      name: "Edit " + filename,
    });
    return !(await isDisabled(editButton));
  }

  /**
   * Uses the Files tab to delete a file.
   *
   * @param filename The filename.
   */
  async deleteFile(
    filename: string,
    dialogChoice: string = "Delete"
  ): Promise<void> {
    await this.openFileActionsMenu(filename);
    const document = await this.document();
    const button = await document.findByRole("menuitem", {
      name: "Delete " + filename,
    });
    await button.click();
    const dialogButton = await document.findByRole("button", {
      name: dialogChoice,
    });
    await dialogButton.click();
  }

  async canDeleteFile(filename: string): Promise<boolean> {
    await this.openFileActionsMenu(filename);
    const document = await this.document();
    const button = await document.findByRole("menuitem", {
      name: `Delete ${filename}`,
    });

    return !(await isDisabled(button));
  }

  /**
   * Wait for an alert, throwing if it doesn't happen.
   *
   * @param title The expected alert title.
   * @param description The expected alert description (if any).
   */
  async findAlertText(title: string, description?: string): Promise<void> {
    const document = await this.document();
    await waitFor(async () => {
      const alerts = await document.findAllByRole("alert", {
        name: title,
      });
      if (description) {
        const matchingDescriptions = await Promise.all(
          alerts.map(async (alert) => {
            const matches = await alert.queryAllByText(description);
            return matches.length > 0;
          })
        );
        if (!matchingDescriptions.some((x) => x)) {
          throw new Error("No description match in matching alerts");
        }
      }
    }, defaultWaitForOptions);
  }

  /**
   * Wait for the editor contents to match the given regexp, throwing if it doesn't happen.
   *
   * Only the first few lines will be visible.
   *
   * @param match The regex.
   */
  async findVisibleEditorContents(
    match: RegExp | string,
    options?: waitForOptions
  ): Promise<void> {
    if (typeof match === "string") {
      match = new RegExp(escapeRegExp(match));
    }
    const document = await this.document();
    let lastText: string | undefined;
    const text = () =>
      document.evaluate(() => {
        // We use the testid to identify the main editor as we also have read-only code views.
        const lines = Array.from(
          window.document.querySelectorAll("[data-testid='editor'] .cm-line")
        );
        return (
          lines
            .map((l) => (l as HTMLElement).innerText)
            // Blank lines here are \n but non-blank lines have no trailing separator. Fix so we can join the text.
            .map((l) => (l === "\n" ? "" : l))
            .join("\n")
        );
      });
    return waitFor(
      async () => {
        const value = await text();
        lastText = value;
        expect(value).toMatch(match);
      },
      {
        ...defaultWaitForOptions,
        onTimeout: (e) =>
          new Error(
            `Timeout waiting for ${match} but content was:\n${lastText}\n\nJSON version:\n${JSON.stringify(
              lastText
            )}`
          ),
        ...options,
      }
    );
  }

  /**
   * Type in the editor area.
   *
   * This will focus the editor area and type with the caret in its default position
   * (the beginning unless we've otherwise interacted with it).
   *
   * @param text The text to type.
   */
  async typeInEditor(text: string): Promise<void> {
    const content = await this.focusEditorContent();
    // The short delay seems to improve reliability triggering autocomplete.
    // Previously finding autocomplete options failed approx 1 in 30 times.
    // https://github.com/microbit-foundation/python-editor-v3/issues/419
    return content.type(text, { delay: 10 });
  }

  /**
   * Select all the text in the code editor.
   *
   * Subsequent typing will overwrite it.
   */
  async selectAllInEditor(): Promise<void> {
    await this.focusEditorContent();
    const keyboard = (await this.page).keyboard;
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await keyboard.down(meta);
    await keyboard.press("a");
    await keyboard.up(meta);
  }

  /**
   * Edit the project name.
   *
   * @param projectName The new name.
   */
  async setProjectName(projectName: string): Promise<void> {
    const document = await this.document();
    const editButton = await document.getByRole("button", {
      name: "Edit project name",
    });
    await editButton.click();
    const input = await document.findByRole("textbox", {
      name: /Name/,
    });
    await input.type(projectName);
    const confirm = await document.findByRole("button", { name: "Confirm" });
    await confirm.click();
  }

  /**
   * Wait for the project name
   *
   * @param match
   * @returns
   */
  async findProjectName(match: string): Promise<void> {
    const text = async () => {
      const document = await this.document();
      const projectName = await document.getByTestId("project-name");
      return projectName.getNodeText();
    };
    return waitFor(async () => {
      const value = await text();
      expect(value).toEqual(match);
    }, defaultWaitForOptions);
  }

  async findActiveApiEntry(text: string, headingLevel: string): Promise<void> {
    // We need to make sure it's actually visible as it's scroll-based navigation.
    const document = await this.document();
    return waitFor(async () => {
      const items = await document.$$(headingLevel);
      const headings = await Promise.all(
        items.map((e) =>
          e.evaluate((node) => {
            const text = (node as HTMLElement).innerText;
            const rect = (node as HTMLElement).getBoundingClientRect();
            const visible = rect.top >= 0 && rect.bottom <= window.innerHeight;
            return { text, visible };
          })
        )
      );
      const match = headings.find((info) => info.visible && info.text === text);
      expect(match).toBeDefined();
    }, defaultWaitForOptions);
  }

  async findDocumentationTopLevelHeading(
    title: string,
    description?: string
  ): Promise<void> {
    const document = await this.document();
    await document.findByText(title, {
      selector: "h2",
    });
    if (description) {
      await document.findByText(description);
    }
  }

  async selectDocumentationSection(name: string): Promise<void> {
    const document = await this.document();
    const button = await document.findByRole("button", {
      name: `View ${name} documentation`,
    });
    await button.click();
    await this.awaitAnimation();
  }

  async awaitAnimation(): Promise<void> {
    const page = await this.page;
    await page.waitForTimeout(300);
  }

  async selectDocumentationIdea(name: string): Promise<void> {
    const document = await this.document();
    const heading = await document.findByText(name, {
      selector: "h3",
    });
    const handle = heading.asElement();
    await handle!.evaluate((element) => {
      element.parentElement?.click();
    });
  }

  async insertToolkitCode(name: string): Promise<void> {
    const document = await this.document();
    const heading = await document.findByText(name, {
      selector: "h3",
    });
    const handle = heading.asElement();
    await handle!.evaluate((element) => {
      const item = element.closest("li");
      item!.querySelector("button")!.click();
    });
  }

  async triggerScroll(tabName: string): Promise<void> {
    const document = await this.document();
    const button = await document.findByRole("button", {
      name: tabName,
    });
    const handle = button.asElement();
    await handle!.evaluate((element) => {
      const scrollablePanel = element.closest(
        "[data-testid='scrollable-panel']"
      );
      scrollablePanel?.scrollTo({ top: 10 });
    });
    await this.awaitAnimation();
  }

  async toggleCodeActionButton(name: string): Promise<void> {
    const document = await this.document();
    const heading = await document.findByText(name, {
      selector: "h3",
    });
    const handle = heading.asElement();
    await handle!.evaluate((element) => {
      const item = element.closest("li");
      (item!.querySelector(".cm-content") as HTMLButtonElement)!.click();
    });
  }

  async waitForTimeout(timeout: number): Promise<void> {
    const page = await this.page;
    await page.waitForTimeout(timeout);
  }

  async copyCode(): Promise<void> {
    const document = await this.document();
    const copyCodeButton = await document.findByRole("button", {
      name: "Copy code",
    });
    await copyCodeButton.click();
  }

  async pasteToolkitCode(): Promise<void> {
    await this.focusEditorContent();
    const keyboard = (await this.page).keyboard;

    if (process.platform === "darwin") {
      await keyboard.down("Shift");
      await keyboard.press("Insert");
      await keyboard.up("Shift");
    } else {
      await keyboard.down("Control");
      await keyboard.press("v");
      await keyboard.up("Control");
    }
  }

  async selectToolkitDropDownOption(
    label: string,
    option: string
  ): Promise<void> {
    const document = await this.document();
    const select = await document.findByLabelText(label);
    await select.select(option);
  }

  /**
   * Trigger a save but don't wait for it to complete.
   *
   * Useful when the action is expected to fail.
   * Otherwise see waitForSave.
   */
  async save(): Promise<void> {
    const document = await this.document();
    const saveButton = await document.getByText("Save");
    return saveButton.click();
  }

  async saveMain(): Promise<void> {
    const document = await this.document();
    const moreSaveOptions = await document.findByTestId("more-save-options");
    await moreSaveOptions.click();
    const saveMainButton = await document.findByRole("menuitem", {
      name: "Save Python script",
    });
    await saveMainButton.click();
  }

  async connect(): Promise<void> {
    const document = await this.document();
    const moreConnectOptions = await document.findByTestId(
      "more-connect-options"
    );
    await moreConnectOptions.click();
    const connectButton = await document.findByRole("menuitem", {
      name: "Connect",
    });
    await connectButton.click();
    await this.connectViaConnectHelp();
  }

  // Connects from the connect dialog/wizard.
  async connectViaConnectHelp(): Promise<void> {
    const document = await this.document();
    const nextButtonOne = await document.findByRole("button", {
      name: "Next",
    });
    await nextButtonOne.click();
    const nextButtonTwo = await document.findByRole("button", {
      name: "Next",
    });
    await nextButtonTwo.click();
  }

  async confirmConnection(): Promise<void> {
    const serialArea = await this.findMainSerialArea();
    await serialArea.findByRole("button", {
      name: "Serial menu",
    });
  }

  async confirmGenericDialog(title: string): Promise<void> {
    const document = await this.document();
    await document.findByText(title, {
      selector: "h2",
    });
  }

  async confirmInputDialog(title: string): Promise<void> {
    const document = await this.document();
    await document.findByText(title, {
      selector: "h2",
    });
  }

  // Launch 'connect help' dialog from 'not found' dialog.
  async connectHelpFromNotFoundDialog(): Promise<void> {
    const document = await this.document();
    const reviewDeviceSelection = await document.findByRole("link", {
      name: "follow these steps",
    });
    await reviewDeviceSelection.click();
  }

  async closeDialog(title?: string): Promise<void> {
    const document = await this.document();
    if (title) {
      await document.findByText(title, {
        selector: "h2",
      });
    }
    // This finds the "X" button in the top right of the dialog
    // and the footer button.
    const closeButton = await document.findAllByRole("button", {
      name: "Close",
    });
    await closeButton[0].click();
  }

  // Retry micro:bit connection from error dialogs.
  async connectViaTryAgain(): Promise<void> {
    const document = await this.document();
    const tryAgainButton = await document.findByRole("button", {
      name: "Try again",
    });
    await tryAgainButton.click();
  }

  async disconnect(): Promise<void> {
    const document = await this.document();
    const moreConnectOptions = await document.findByTestId(
      "more-connect-options"
    );
    await moreConnectOptions.click();
    const disconnectButton = await document.findByRole("menuitem", {
      name: "Disconnect",
    });
    await disconnectButton.click();
    return waitFor(
      async () => {
        expect(
          (
            await document.queryAllByRole("button", {
              name: "Serial terminal",
            })
          ).length
        ).toEqual(0);
      },
      {
        ...defaultWaitForOptions,
        onTimeout: () => new Error("Serial still present after disconnect"),
      }
    );
  }

  private async findMainSerialArea() {
    const document = await this.document();
    return document.findByRole("region", {
      name: "Serial terminal",
    });
  }

  async serialShow(): Promise<void> {
    const mainSerialArea = await this.findMainSerialArea();
    const showSerialButton = await mainSerialArea.findByRole("button", {
      name: "Show serial",
    });
    await showSerialButton.click();
    // Make sure the button has flipped.
    await mainSerialArea.findByRole("button", {
      name: "Hide serial",
    });
  }

  async serialHide(): Promise<void> {
    const serialArea = await this.findMainSerialArea();
    const hideSerialButton = await serialArea.findByRole("button", {
      name: "Hide serial",
    });
    await hideSerialButton.click();
    // Make sure the button has flipped.
    await serialArea.findByRole("button", {
      name: "Show serial",
    });
  }

  async findSerialCompactTraceback(text: Matcher): Promise<void> {
    const document = await this.document();
    await document.findByText(text);
  }

  async flash() {
    const document = await this.document();
    const flash = await document.findByRole("button", {
      name: "Send to Calliope mini",
    });
    return flash.click();
  }

  async followSerialCompactTracebackLink(): Promise<void> {
    const document = await this.document();
    const link = await document.findByTestId("traceback-link");
    await link.click();
  }

  async mockSerialWrite(data: string): Promise<void> {
    const page = await this.page;
    page.evaluate((data) => {
      (window as any).mockDevice.mockSerialWrite(data);
    }, toCrLf(data));
  }

  async mockDeviceConnectFailure(code: WebUSBErrorCode) {
    const page = await this.page;
    page.evaluate((code) => {
      (window as any).mockDevice.mockConnect(code);
    }, code);
  }

  async mockWebUsbNotSupported() {
    const page = await this.page;
    page.evaluate(() => {
      (window as any).mockDevice.mockWebUsbNotSupported();
    });
  }

  /**
   * Trigger a hex file save and wait for the download to complete.
   *
   * @returns Download details.
   */
  async waitForSave(): Promise<BrowserDownload> {
    return this.waitForDownloadOnDisk(() => this.save());
  }

  /**
   * Resets the page for a new test.
   */
  async reset() {
    let page = await this.page;
    if (!page.isClosed()) {
      page.removeAllListeners();
      await page.close();
    }
    this.page = this.createPage();
    page = await this.page;
    await page.goto(this.url);
  }

  /**
   * Navigate to the URL defined by options.
   *
   * Only needed to test initialization scenarios when options has been
   * changed by the test.
   */
  async gotoOptionsUrl() {
    let page = await this.page;
    // Allow testing fragment changes by actually navigating away.
    await page.goto("about:blank");
    return page.goto(this.url);
  }

  /**
   * Wait for matching completion options to appear.
   */
  async findCompletionOptions(expected: string[]): Promise<void> {
    const document = await this.document();
    return waitFor(async () => {
      const items = await document.$$(".cm-completionLabel");
      const actual = await Promise.all(
        items.map((e) => e.evaluate((node) => (node as HTMLElement).innerText))
      );
      expect(actual).toEqual(expected);
    }, defaultWaitForOptions);
  }

  /**
   * Wait for the a signature tooltip to appear with a matching signature.
   */
  async findSignatureHelp(expectedSignature: string): Promise<void> {
    const document = await this.document();
    return waitFor(async () => {
      const tooltip = await document.$(".cm-signature-tooltip code");
      expect(tooltip).toBeTruthy();
      const actualSignature = await tooltip!.evaluate(
        (e) => (e as HTMLElement).innerText
      );
      expect(actualSignature).toEqual(expectedSignature);
    }, defaultWaitForOptions);
  }

  /**
   * Wait for active completion option by waiting for its signature to be shown
   * in the documentation tooltip area.
   */
  async findCompletionActiveOption(signature: string): Promise<void> {
    const document = await this.document();
    await document.findByText(
      signature,
      {
        selector: "code",
      },
      defaultWaitForOptions
    );
  }

  /**
   * Accept the given completion.
   */
  async acceptCompletion(name: string): Promise<void> {
    // This seems significantly more reliable than pressing Enter, though there's
    // no real-life issue here.
    const document = await this.document();
    const option = await document.findByRole(
      "option",
      {
        name,
      },
      defaultWaitForOptions
    );
    await option.click();
  }

  /**
   * Follow the documentation link shown in the signature help or autocomplete tooltips.
   * This will update the "API" tab and switch to it.
   */
  async followCompletionOrSignatureDocumentionLink(
    linkName: string
  ): Promise<void> {
    const document = await this.document();
    const button = await document.findByRole("link", {
      name: linkName,
    });
    return button.click();
  }

  /**
   * Drag the first code snippet from the named section to the target line.
   * The section must alread be in view.
   *
   * @param name The name of the section.
   * @param targetLine The target line (1-based).
   */
  async dragDropCodeEmbed(name: string, targetLine: number) {
    const page = await this.page;
    const document = await this.document();
    const heading = await document.findByRole("heading", {
      name,
      level: 3,
    });
    const section = await heading.evaluateHandle<ElementHandle>(
      (e: Element) => {
        let node: Element | null = e;
        while (node && node.tagName !== "LI") {
          node = node.parentElement;
        }
        if (!node) {
          throw new Error("Unexpected DOM structure");
        }
        return node;
      }
    );
    const draggable = (await section.$("[draggable]"))!;
    const lines = await document.$$("[data-testid='editor'] .cm-line");
    const line = lines[targetLine - 1];
    if (!line) {
      throw new Error(`No line ${targetLine} found. Line must exist.`);
    }
    await page.setDragInterception(true);
    await draggable.dragAndDrop(line);
  }

  async resetProject(): Promise<void> {
    await this.switchTab("Project");
    await this.findAndClickButton("Reset project");
    await this.findAndClickButton("Replace");
  }

  async findProjectFiles(expected: string[]): Promise<void> {
    const tab = await this.switchTab("Project");
    const items = async () => {
      const items = await tab.findAllByRole("listitem");
      const text = await Promise.all(
        items.map((i) => i.evaluate((e) => e.textContent))
      );
      return text;
    };
    return waitFor(async () => {
      const actual = await items();
      expect(actual).toEqual(expected);
    }, defaultWaitForOptions);
  }

  /**
   * Take a screenshot named after the running test case and store it in the reports folder.
   * The folder is published in CI.
   */
  async screenshot() {
    const page = await this.page;
    return page.screenshot({
      path: this.reportFilename("png"),
    });
  }

  private reportFilename(extension: string): string {
    return (
      reportsPath +
      // GH actions has character restrictions
      expect.getState().currentTestName.replace(/[^0-9a-zA-Z]+/g, "-") +
      "." +
      extension
    );
  }

  private async focusEditorContent(): Promise<ElementHandle> {
    const document = await this.document();
    const content = await document.$("[data-testid='editor'] .cm-content");
    if (!content) {
      throw new Error("Missing editor area");
    }
    await content.focus();
    return content;
  }

  /**
   * Clean up, including the browser and downloads temporary folder.
   */
  async dispose() {
    await fsp.rm(this.downloadPath, { recursive: true });
    const page = await this.page;
    await page.browser().close();
  }

  /**
   * Switch to a sidebar tab.
   *
   * Prefer more specific navigation actions, but this is useful to check initial state
   * and that tab state is remembered.
   */
  async switchTab(
    tabName: "Project" | "API" | "Reference" | "Ideas"
  ): Promise<ElementHandle<Element>> {
    const document = await this.document();
    const tab = await document.findByRole("tab", {
      name: tabName,
    });
    await tab.click();
    return document.findByRole("tabpanel");
  }

  async searchToolkits(searchText: string): Promise<void> {
    const document = await this.document();
    const searchButton = await document.findByRole("button", {
      name: "Search",
    });
    await searchButton.click();
    const searchField = await document.findByRole("textbox", {
      name: "Search",
    });
    await searchField.type(searchText);
  }

  async selectFirstSearchResult(): Promise<void> {
    const document = await this.document();
    const modalDialog = await document.findByRole("dialog");
    const result = await modalDialog.findAllByRole("heading", {
      level: 3,
    });
    await result[0].click();
  }

  async tabOutOfEditorForwards(): Promise<void> {
    const content = await this.focusEditorContent();
    await content.press("Escape");
    await content.press("Tab");
  }

  async tabOutOfEditorBackwards(): Promise<void> {
    const keyboard = (await this.page).keyboard;

    const content = await this.focusEditorContent();
    await content.press("Escape");
    await keyboard.down("Shift");
    await content.press("Tab");
    await keyboard.up("Shift");
  }

  private async document(): Promise<puppeteer.ElementHandle<Element>> {
    const page = await this.page;
    return page.getDocument();
  }

  private async waitForDownloadOnDisk(
    triggerDownload: () => Promise<void>,
    timeout: number = 5000
  ): Promise<BrowserDownload> {
    const listDir = async () => {
      const listing = await fsp.readdir(this.downloadPath);
      return new Set(listing.filter((x) => !x.endsWith(".crdownload")));
    };

    const before = await listDir();
    await triggerDownload();

    const startTime = performance.now();
    while (true) {
      const after = await listDir();
      before.forEach((x) => after.delete(x));
      if (after.size === 1) {
        const filename = after.values().next().value;
        const data = await fsp.readFile(path.join(this.downloadPath, filename));
        return { filename, data };
      }
      if (after.size > 1) {
        throw new Error("Unexpected extra file in downloads directory");
      }
      if (performance.now() - startTime > timeout) {
        throw new Error("Timeout waiting for puppeteer download");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async openFileActionsMenu(filename: string): Promise<void> {
    await this.switchTab("Project");
    const document = await this.document();
    const actions = await document.findByRole("button", {
      name: `${filename} file actions`,
    });
    await actions.click();
  }

  private async keyboardPress(key: puppeteer.KeyInput): Promise<void> {
    const keyboard = (await this.page).keyboard;
    await keyboard.press(key);
  }

  private async getElementByRoleAndLabel(
    role: string,
    name: string
  ): Promise<puppeteer.ElementHandle<Element>> {
    return (await this.document()).findByRole(role, {
      name,
    });
  }

  private async getElementByQuerySelector(
    query: string
  ): Promise<puppeteer.ElementHandle<Element>> {
    return (await this.page).evaluateHandle<ElementHandle>(
      (query) => document.querySelector(query),
      query
    );
  }

  async assertActiveElement(
    accessExpectedElement: () => Promise<puppeteer.ElementHandle<Element>>
  ) {
    return waitFor(async () => {
      const page = await this.page;
      const expectedElement = await accessExpectedElement();

      expect(
        await page.evaluate((e) => {
          return e === document.activeElement;
        }, expectedElement)
      ).toEqual(true);
    }, defaultWaitForOptions);
  }

  async assertFocusOnLoad(): Promise<void> {
    await this.keyboardPress("Tab");
    return this.assertActiveElement(() =>
      this.getElementByRoleAndLabel(
        "link",
        "visit calliope.cc (opens in a new tab)"
      )
    );
  }

  collapseSimulator(): Promise<void> {
    return this.findAndClickButton("Collapse simulator");
  }

  expandSimulator(): Promise<void> {
    return this.findAndClickButton("Expand simulator");
  }

  collapseSidebar(): Promise<void> {
    return this.findAndClickButton("Collapse sidebar");
  }

  expandSidebar(): Promise<void> {
    return this.findAndClickButton("Expand sidebar");
  }

  async assertFocusOnExpandSimulator(): Promise<void> {
    const document = await this.document();
    return this.assertActiveElement(() =>
      document.getByRole("button", { name: "Expand simulator" })
    );
  }

  assertFocusOnSimulator(): Promise<void> {
    return this.assertActiveElement(() =>
      this.getElementByQuerySelector("iframe[name='Simulator']")
    );
  }

  async assertFocusOnExpandSidebar(): Promise<void> {
    const document = await this.document();
    return this.assertActiveElement(() =>
      document.findByRole("button", { name: "Expand sidebar" })
    );
  }

  assertFocusOnSidebar(): Promise<void> {
    return this.assertActiveElement(() =>
      this.getElementByQuerySelector("[role='tabpanel']")
    );
  }

  async assertFocusBeforeEditor(): Promise<void> {
    const document = await this.document();
    return this.assertActiveElement(() =>
      document.findByRole("button", {
        name: "Zoom in",
      })
    );
  }

  async assertFocusAfterEditor(): Promise<void> {
    const document = await this.document();
    return this.assertActiveElement(() =>
      document.findByRole("button", {
        name: "Send to Calliope mini",
      })
    );
  }

  // Simulator functions
  private async getSimulatorIframe(): Promise<puppeteer.Frame> {
    const page = await this.page;
    const simulatorIframe = page
      .frames()
      .find((frame) => frame.name() === "Simulator");
    if (!simulatorIframe) {
      throw new Error("Simulator iframe not found");
    }
    return simulatorIframe;
  }

  async runSimulator(): Promise<void> {
    const simulatorIframe = await this.getSimulatorIframe();
    const playButton = await simulatorIframe!.$(".play-button");
    await playButton!.click();
  }

  async findStoppedSimulator(): Promise<void> {
    const document = await this.document();
    const stopButton = await document.findByRole("button", {
      name: "Stop simulator",
    });
    waitFor(async () => {
      expect(await isDisabled(stopButton)).toEqual(true);
    }, defaultWaitForOptions);
  }

  async simulatorSelectGesture(option: string): Promise<void> {
    const document = await this.document();
    const select = await document.findByTestId("simulator-gesture-select");
    await select.select(option);
  }

  async simulatorSendGesture(): Promise<void> {
    const document = await this.document();
    const gestureSendBtn = await document.getByRole("button", {
      name: "Send gesture",
    });
    await gestureSendBtn.click();
  }

  async simulatorInputPressHold(
    name: string,
    pressDuration: number
  ): Promise<void> {
    const page = await this.page;
    const document = await this.document();
    const inputButton = await document.getByRole("button", {
      name,
    });
    const bounding_box = await inputButton!.boundingBox();
    await page.mouse.move(
      bounding_box!.x + bounding_box!.width / 2,
      bounding_box!.y + bounding_box!.height / 2
    );
    await page.mouse.down();
    await page.waitForTimeout(pressDuration);
    await page.mouse.up();
  }

  async simulatorSetRangeSlider(
    sliderLabel: string,
    value: "min" | "max"
  ): Promise<void> {
    const page = await this.page;
    const document = await this.document();
    const sliderThumb = await document.waitForSelector(
      `[role="slider"][aria-label="${sliderLabel}"]`
    );
    const bounding_box = await sliderThumb!.boundingBox();
    await page.mouse.move(
      bounding_box!.x + bounding_box!.width / 2,
      bounding_box!.y + bounding_box!.height / 2
    );
    await page.mouse.down();
    await page.waitForTimeout(500);
    await page.mouse.move(value === "max" ? 1200 : 0, 0);
    await page.waitForTimeout(500);
    await page.mouse.up();
  }

  async simulatorConfirmResponse(): Promise<void> {
    // Confirms that top left LED is switched on
    // to match Image.NO being displayed.
    const simulatorIframe = await this.getSimulatorIframe();
    const gridLEDs = await simulatorIframe!.$("#LED-Matrix");
    await gridLEDs!.waitForSelector("path", { visible: true, timeout: 1000 });
  }
}

/**
 * Checks whether an element is disabled.
 *
 * @param element an element handle.
 * @returns true if the element exists and is marked disabled.
 */
const isDisabled = async (element: ElementHandle<Element>) => {
  if (!element) {
    return false;
  }
  const disabled = await element.getProperty("disabled");
  return disabled && (await disabled.jsonValue());
};

const toCrLf = (text: string): string =>
  text.replace(/[\r\n]/g, "\n").replace(/\n/g, "\r\n");
