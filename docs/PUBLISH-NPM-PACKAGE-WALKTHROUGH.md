# Step-by-step: Create and publish a private npm package (GitHub Packages)

This walkthrough is for publishing **@asoldi/client-cms** from the **website-cms** repo as a **private** npm package using **GitHub Packages**. You can use the same steps for any other private package.

---

## Part A: Prepare the package (website-cms repo)

### 1. Open the website-cms project

- In File Explorer go to: `c:\Asoldi\Asoldi code\website-cms`
- Open that folder in Cursor (or VS Code): **File → Open Folder → website-cms**

### 2. Decide the package scope

- **Scope** = the part before the slash, e.g. `@asoldi` in `@asoldi/client-cms`.
- **Option A:** Use your **GitHub username** as scope (e.g. `@damianhch/client-cms`). No extra setup.
- **Option B:** Use `@asoldi`. You need a **GitHub organization** named `asoldi` (or an npm org). If you don’t have one, use Option A for now.

**If using Option A (recommended first):**  
Edit `website-cms/package.json` and change the name to your scoped name, e.g.:

```json
"name": "@damianhch/client-cms",
```

Replace `damianhch` with your GitHub username. Save the file.

**If using Option B:**  
Keep `"name": "@asoldi/client-cms"` and ensure you have a GitHub org `asoldi` (or will create one in Part B).

### 3. Ensure package.json is correct

In `website-cms/package.json` check:

- `"name"`: `@your-scope/client-cms` (e.g. `@damianhch/client-cms` or `@asoldi/client-cms`)
- `"version"`: e.g. `"1.0.0"`
- `"private": false` (or remove `"private"`) so it can be published
- `"publishConfig"` for GitHub Packages (add if missing – see step 5 below)

### 4. Add publishConfig for GitHub Packages

In `website-cms/package.json`, add a `"publishConfig"` section (adjust the repo URL if yours is different):

```json
{
  "name": "@damianhch/client-cms",
  "version": "1.0.0",
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  },
  ...
}
```

- If you use `@asoldi`, the registry is still `https://npm.pkg.github.com` (GitHub hosts it; scope can be your org).
- Save the file.

### 5. Commit and push (if not already)

- In a terminal inside `website-cms`:
  - `git add .`
  - `git commit -m "Prepare for npm publish"`
  - `git push origin main`
- So GitHub has the latest code before you publish.

---

## Part B: Create a GitHub Personal Access Token (PAT)

You need a token so npm can publish to GitHub Packages.

### 1. Open GitHub token settings

- Go to **https://github.com**
- Log in.
- Click your **profile picture (top right)** → **Settings**.
- In the left sidebar, scroll down to **Developer settings** → click it.
- Click **Personal access tokens** → **Tokens (classic)** (or **Fine-grained tokens** if you prefer; classic is simpler for this).

### 2. Generate a new token

- Click **Generate new token** → **Generate new token (classic)**.
- **Note:** e.g. `npm-publish-website-cms`.
- **Expiration:** choose e.g. 90 days or No expiration (you can rotate later).
- **Scopes:** enable:
  - **write:packages** – to publish
  - **read:packages** – to install private packages
  - **repo** – if the repo is private (so the token can access it)
- Click **Generate token** at the bottom.

### 3. Copy the token

- You’ll see the token **once**. Copy it and store it somewhere safe (e.g. password manager).
- You’ll use it in Part C as `YOUR_GITHUB_TOKEN`.

---

## Part C: Log in to GitHub Packages with npm

npm must authenticate to `npm.pkg.github.com` using your token.

### 1. Open a terminal

- Use PowerShell or Command Prompt (or the terminal in Cursor/VS Code).
- You can do this from any folder; the next command is global for your machine.

### 2. Set the registry for your scope

Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username (e.g. `Damianhch`).  
If you use an org scope (e.g. `asoldi`), use the org name.

```bash
npm config set @damianhch:registry https://npm.pkg.github.com
```

So for scope `@damianhch` it’s `@damianhch:registry`. For `@asoldi` it would be `@asoldi:registry`.

### 3. Log in to GitHub Packages

Run (replace the placeholders):

```bash
npm login --registry=https://npm.pkg.github.com
```

When prompted:

- **Username:** your GitHub username (e.g. `Damianhch`).
- **Password:** paste the **Personal Access Token** (not your GitHub password).
- **Email:** your email (can be public or your GitHub no-reply email).

You should see: `Logged in as ... on https://npm.pkg.github.com/`.

### 4. (Optional) Store token in .npmrc

Instead of logging in interactively each time, you can put the token in an `.npmrc` file **only on your machine** (never commit this file if it contains the token).

- On Windows, user `.npmrc` is usually: `C:\Users\YourUsername\.npmrc`
- Add or edit so it has (one line, no line break in the middle):

```ini
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Replace `YOUR_GITHUB_TOKEN` with your PAT. Save. Then you don’t need to run `npm login` again until the token expires.

---

## Part D: Publish the package

### 1. Go to the package folder

```bash
cd "c:\Asoldi\Asoldi code\website-cms"
```

### 2. Make sure the repo is linked (for GitHub Packages)

GitHub Packages expects the package to come from a GitHub repo. In `package.json` you should have something like:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/Damianhch/website-cms.git"
}
```

If your repo URL is different, fix it and save.

### 3. Publish

```bash
npm publish
```

- If the package name is **scoped** (e.g. `@damianhch/client-cms`) and you **don’t** add `--access public`, npm will publish it as **restricted** (private for GitHub Packages when using GitHub’s registry).
- For a **private** package on GitHub Packages you don’t need `--access public`; it will be private by default for that scope.

If something fails:

- **404 / Forbidden:** Check that the token has `write:packages` and (if repo is private) `repo`.
- **Package name already exists:** Change `version` in `package.json` (e.g. to `1.0.1`) and run `npm publish` again.
- **Registry / scope:** Ensure `@your-scope:registry` is `https://npm.pkg.github.com` and you’re logged in to that registry.

### 4. Confirm it’s there

- Go to **https://github.com/Damianhch/website-cms** (or your repo).
- Click **Packages** on the right (or go to **Your profile → Packages**). You should see `client-cms` (or the name in package.json).

---

## Part E: Use the private package in another project (e.g. a client site)

### 1. In the client project, configure the scope registry

In the **client** project (the website where you install the CMS), ensure npm knows where to get `@damianhch/client-cms` (or `@asoldi/client-cms`):

- Either run once (replace scope with yours):

  ```bash
  npm config set @damianhch:registry https://npm.pkg.github.com
  ```

- Or in that project create (or edit) **.npmrc** in the project root:

  ```ini
  @damianhch:registry=https://npm.pkg.github.com
  ```

  Use your actual scope instead of `damianhch` if different.

### 2. Authenticate so the client project can install private packages

On the machine (or CI) that will run `npm install`:

- Either run:

  ```bash
  npm login --registry=https://npm.pkg.github.com
  ```

  (same as in Part C),  
- Or put the same `//npm.pkg.github.com/:_authToken=...` in your **user** `.npmrc` (again, never commit the token).

### 3. Install the package in the client project

```bash
cd path\to\client-website
npm install @damianhch/client-cms
```

Use your real scope and package name (e.g. `@asoldi/client-cms` if you used that). Then add the mount, route, and **Hostinger env** (CMS_HUB_URL, CMS_SITE_KEY) as in **[CLIENT-SITE-DEPLOYMENT.md](CLIENT-SITE-DEPLOYMENT.md)**.

---

## Quick checklist

- [ ] package.json: correct `name` (e.g. `@damianhch/client-cms`), `version`, `publishConfig.registry = https://npm.pkg.github.com`, `repository` URL.
- [ ] GitHub: PAT created with `write:packages`, `read:packages`, and `repo` if repo is private.
- [ ] npm: `@your-scope:registry` set to `https://npm.pkg.github.com`, logged in with PAT.
- [ ] From `website-cms`: `npm publish`.
- [ ] In client project: scope registry set, logged in, then `npm install @your-scope/client-cms`.

That’s the full click-by-click flow for creating and publishing your private npm package and using it in another project.
