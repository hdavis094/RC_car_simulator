#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest.h>

#include <cstdio>

namespace {
// --duration prints completed cases. Flush a start marker too, so a blocked case
// is visible immediately and the parent watchdog can name it before killing it.
struct CaseProgress : doctest::IReporter {
  const char* name = "";
  explicit CaseProgress(const doctest::ContextOptions&) {}
  void test_case_start(const doctest::TestCaseData& data) override {
    name = data.m_name;
    std::fprintf(stderr, "[starter-test] RUN %s\n", name);
    std::fflush(stderr);
  }
  void test_case_end(const doctest::CurrentTestCaseStats&) override {
    std::fprintf(stderr, "[starter-test] DONE %s\n", name);
    std::fflush(stderr);
  }
  void report_query(const doctest::QueryData&) override {}
  void test_run_start() override {}
  void test_run_end(const doctest::TestRunStats&) override {}
  void test_case_reenter(const doctest::TestCaseData&) override {}
  void test_case_exception(const doctest::TestCaseException&) override {}
  void subcase_start(const doctest::SubcaseSignature&) override {}
  void subcase_end() override {}
  void log_assert(const doctest::AssertData&) override {}
  void log_message(const doctest::MessageData&) override {}
  void test_case_skipped(const doctest::TestCaseData&) override {}
};
DOCTEST_REGISTER_LISTENER("case-progress", 0, CaseProgress);
}  // namespace
