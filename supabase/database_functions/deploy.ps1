# Deploy-Skript: alle database_functions/*.sql gegen die verlinkte DB.
# Voraussetzung: supabase link + supabase login
#
# Usage (aus Repo-Root):
#   .\supabase\database_functions\deploy.ps1
#   .\supabase\database_functions\deploy.ps1 -Local
#Requires -Version 5.1
param(
  [switch]$Local
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = if ($Local) { "--local" } else { "--linked" }

$files = Get-ChildItem -Path $here -Filter "*.sql" | Sort-Object Name
if ($files.Count -eq 0) {
  Write-Error "Keine .sql-Dateien in $here"
}

Write-Host "Deploy nach $target ($($files.Count) Dateien)..."
foreach ($f in $files) {
  Write-Host "-> $($f.Name)"
  & supabase db query $target -f $f.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Deploy fehlgeschlagen bei $($f.Name) (exit $LASTEXITCODE)"
  }
}
Write-Host "Fertig."
