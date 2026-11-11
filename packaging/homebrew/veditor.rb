cask "veditor" do
  version "4.0.0"
  sha256 :no_check

  url "https://github.com/v3ndettaaa/veditor/releases/download/v#{version}/veditor_#{version}_aarch64.dmg"
  name "veditor"
  desc "Native-grade desktop PDF editor and annotation workspace"
  homepage "https://github.com/v3ndettaaa/veditor"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "veditor.app"

  zap trash: [
    "~/Library/Application Support/com.veditor.desktop",
    "~/Library/Caches/com.veditor.desktop",
    "~/Library/Preferences/com.veditor.desktop.plist",
    "~/Library/Saved Application State/com.veditor.desktop.savedState",
  ]
end
