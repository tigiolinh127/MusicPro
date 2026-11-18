#include "msp/Engine.h"

#include <iostream>
#include <memory>
#include <string>
#include <thread>

namespace {
class StdErrLogger final : public juce::Logger {
public:
    void logMessage(const juce::String& message) override {
        std::cerr << message << '\n';
    }
};
} // namespace

int main() {
    try {
        juce::MessageManager::getInstance();
        StdErrLogger logger;
        juce::Logger::setCurrentLogger(&logger);
        auto engine = std::make_unique<msp::Engine>();
        engine->start();

        std::thread reader([&engine] {
            std::string line;
            while (std::getline(std::cin, line)) {
                auto copy = std::make_shared<std::string>(std::move(line));
                juce::MessageManager::callAsync([copy, &engine] {
                    if (engine != nullptr)
                        engine->handleLine(*copy);
                });
            }
            juce::MessageManager::callAsync([&engine] {
                if (engine != nullptr)
                    engine->shutdown(false);
            });
        });

        if (auto* messages = juce::MessageManager::getInstance())
            messages->runDispatchLoop();
        engine.reset();
        reader.join();
        juce::Logger::setCurrentLogger(nullptr);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Engine failed: " << error.what() << '\n';
        return 1;
    }
}
