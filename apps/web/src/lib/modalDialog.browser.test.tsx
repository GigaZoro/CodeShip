import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AlertDialog, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { isInsideModalDialog } from "./modalDialog";

it.each([
  {
    name: "dialog",
    dialog: (
      <Dialog open>
        <DialogPopup>
          <DialogTitle>Rename thread</DialogTitle>
          <button type="button">Keep</button>
        </DialogPopup>
      </Dialog>
    ),
  },
  {
    name: "alert dialog",
    dialog: (
      <AlertDialog open>
        <AlertDialogPopup>
          <AlertDialogTitle>Edit from here?</AlertDialogTitle>
          <button type="button">Keep</button>
        </AlertDialogPopup>
      </AlertDialog>
    ),
  },
])("treats keys pressed in an open $name as the dialog's own", async ({ dialog }) => {
  await using _screen = await render(dialog);
  const button = page.getByRole("button", { name: "Keep" });
  await expect.element(button).toBeVisible();
  expect(isInsideModalDialog(button.element())).toBe(true);
});
