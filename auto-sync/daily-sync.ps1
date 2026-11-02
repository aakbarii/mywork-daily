# MyWork auto daily sync - runs on your Windows PC, e.g. via Task Scheduler at 17:55.
# It does NOT commit or push your project code.
# It only builds a daily JSON summary (file names + commit subjects, no file contents)
# and pushes THAT JSON to the mywork-daily repo.
# First-time setup (once):
#   1. This folder lives inside the mywork-daily repo (https://github.com/aakbarii/mywork-daily).
#   2. Daily JSON files are written to the repo root, next to the auto-sync folder.
$DailyRepo = Split-Path $PSScriptRoot -Parent
$CollectorDir = $PSScriptRoot
$date = Get-Date -Format yyyy-MM-dd
$json = Join-Path $DailyRepo "mywork-$date.json"
node (Join-Path $CollectorDir "collect.mjs") --date $date --roots "$env:USERPROFILE\Desktop\MyWork" > $json
Set-Location $DailyRepo
git checkout -B main 2>$null
git add "mywork-$date.json"
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m "daily summary $date"
    git push -u origin main
    Write-Host "Pushed daily summary $date"
} else {
    Write-Host "No changes today, nothing pushed"
}
