[CmdletBinding()]
param(
  [string]$BaseUrl = 'https://wxbackend.sclh.com.cn',
  [string]$ReleaseNotes = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $repoRoot 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
$productName = [string]$package.build.productName
$installerPath = Join-Path $repoRoot "release\document-sanitizer-restore-$version-win-x64.exe"

if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "Installer not found: $installerPath. Run npm.cmd run dist:win first."
}

$installer = Get-Item -LiteralPath $installerPath
$maximumBytes = 500MB
if ($installer.Length -gt $maximumBytes) {
  throw "Installer exceeds the software center 500 MB limit: $($installer.Length) bytes."
}

$hash = Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256
Write-Host "Ready to publish: $productName v$version" -ForegroundColor Cyan
Write-Host "Installer: $($installer.FullName)"
Write-Host "Size: $([math]::Round($installer.Length / 1MB, 2)) MiB"
Write-Host "SHA-256: $($hash.Hash)"

$credential = Get-Credential -Message 'Enter the software center super_admin credentials'
$loginBodyJson = @{
  username = $credential.UserName
  password = $credential.GetNetworkCredential().Password
} | ConvertTo-Json
$loginBody = [System.Text.Encoding]::UTF8.GetBytes($loginBodyJson)

$session = Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl/admin/auth/login" `
  -ContentType 'application/json; charset=utf-8' `
  -Body $loginBody

if (-not $session.token) {
  throw 'Login succeeded without returning an access token.'
}

$headers = @{ Authorization = "Bearer $($session.token)" }
$products = @(
  Invoke-RestMethod `
    -Method Get `
    -Uri "$BaseUrl/software-center/admin/products" `
    -Headers $headers
)
$product = @($products | Where-Object { $_.name -eq $productName })[0]

if (-not $product) {
  $productBodyJson = @{
    name = $productName
    platform = 'Windows 10/11 x64'
    description = [string]$package.description
    isActive = $true
    sortOrder = 0
  } | ConvertTo-Json
  $productBody = [System.Text.Encoding]::UTF8.GetBytes($productBodyJson)

  $product = Invoke-RestMethod `
    -Method Post `
    -Uri "$BaseUrl/software-center/admin/products" `
    -Headers $headers `
    -ContentType 'application/json; charset=utf-8' `
    -Body $productBody
}

if (-not $product.isActive) {
  $activationBody = [System.Text.Encoding]::UTF8.GetBytes((@{ isActive = $true } | ConvertTo-Json))
  $product = Invoke-RestMethod `
    -Method Patch `
    -Uri "$BaseUrl/software-center/admin/products/$($product.id)" `
    -Headers $headers `
    -ContentType 'application/json; charset=utf-8' `
    -Body $activationBody
}

if ([string]::IsNullOrWhiteSpace($ReleaseNotes)) {
  $ReleaseNotes = Read-Host 'Enter release notes'
}
if ([string]::IsNullOrWhiteSpace($ReleaseNotes)) {
  throw 'Release notes cannot be empty.'
}

$uploadUrl = "$BaseUrl/software-center/admin/products/$($product.id)/releases"
& curl.exe --fail-with-body --request POST `
  --header "Authorization: Bearer $($session.token)" `
  --form-string "version=$version" `
  --form-string "releaseNotes=$ReleaseNotes" `
  --form-string "originalName=$($installer.Name)" `
  --form "file=@$($installer.FullName);type=application/octet-stream" `
  $uploadUrl

if ($LASTEXITCODE -ne 0) {
  throw "Installer upload failed. curl exit code: $LASTEXITCODE"
}

$publicProducts = @(
  Invoke-RestMethod -Method Get -Uri "$BaseUrl/software-center/products"
)
$published = @($publicProducts | Where-Object { $_.name -eq $productName })[0]
if (-not $published -or $published.latestRelease.version -ne $version) {
  throw 'The public API does not report the version that was just uploaded.'
}

Write-Host ''
Write-Host "Published successfully: $productName v$version" -ForegroundColor Green
Write-Host "Public downloads: $BaseUrl/downloads"
Write-Host "Local SHA-256: $($hash.Hash)"
