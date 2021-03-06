"use strict";

import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import sinon from "sinon";

import Api from "../src";
import { checkVersion } from "../src/utils";
import { EventEmitter } from "events";
import KintoServer from "kinto-node-test-server";
import { delayedPromise } from "./test_utils";

chai.use(chaiAsPromised);
chai.should();
chai.config.includeStack = true;

const TEST_KINTO_SERVER = "http://0.0.0.0:8888/v1";

describe("Integration tests", function() {
  let sandbox, server, api;

  // Disabling test timeouts until pserve gets decent startup time.
  this.timeout(0);

  before(() => {
    server = new KintoServer(TEST_KINTO_SERVER, {
      maxAttempts: 200,
      kintoConfigPath: __dirname + "/kinto.ini",
    });
  });

  after(() => server.killAll());

  function createClient(options={}) {
    return new Api(TEST_KINTO_SERVER, options);
  }

  beforeEach(function() {
    this.timeout(12500);

    sandbox = sinon.sandbox.create();
    const events = new EventEmitter();
    api = createClient({
      events,
      headers: {Authorization: "Basic " + btoa("user:pass")}
    });
  });

  afterEach(() => sandbox.restore());

  describe("Default server configuration", () => {
    before(() => {
      return server.start();
    });

    after(() => server.stop());

    beforeEach(() => server.flush());

    // XXX move this to batch tests
    describe("new batch", () => {
      it("should support root batch", () => {
        return api.batch(batch => {
          const bucket = batch.bucket("default");
          bucket.createCollection("posts");
          const coll = bucket.collection("posts");
          coll.createRecord({a: 1});
          coll.createRecord({a: 2});
        })
          .then(_ => api.bucket("default").collection("posts").listRecords())
          .then(res => res.data)
          .should.eventually.have.length.of(2);
      });

      it("should support bucket batch", () => {
        return api.bucket("default").batch(batch => {
          batch.createCollection("posts");
          const coll = batch.collection("posts");
          coll.createRecord({a: 1});
          coll.createRecord({a: 2});
        })
          .then(_ => api.bucket("default").collection("posts").listRecords())
          .then(res => res.data)
          .should.eventually.have.length.of(2);
      });
    });

    describe("Server properties", () => {
      it("should retrieve server settings", () => {
        return api.fetchServerSettings()
          .should.eventually.have.property("batch_max_requests").eql(25);
      });

      it("should retrieve server capabilities", () => {
        return api.fetchServerCapabilities()
          .then(capabilities => {
            expect(capabilities).to.be.an("object");

            // Kinto protocol 1.4 exposes capability descriptions
            Object.keys(capabilities).forEach(capability => {
              const capabilityObj = capabilities[capability];
              expect(capabilityObj).to.include.keys("url", "description");
            });
          });
      });

      it("should retrieve user information", () => {
        return api.fetchUser()
          .then(user => {
            expect(user.id).to.match(/^basicauth:/);
            expect(user.bucket).to.have.length.of(36);
          });
      });

      it("should retrieve current API version", () => {
        return api.fetchHTTPApiVersion()
          .should.eventually.match(/^\d\.\d+$/);
      });
    });

    describe("#createBucket", () => {
      let result;

      describe("Default options", () => {
        beforeEach(() => {
          return api.createBucket("foo")
            .then(res => result = res);
        });

        it("should create a bucket with the passed id", () => {
          expect(result).to.have.property("data")
                        .to.have.property("id").eql("foo");
        });

        it("should create a bucket having a list of write permissions", () => {
          expect(result).to.have.property("permissions")
                        .to.have.property("write").to.be.a("array");
        });

        describe("data option", () => {
          it("should create bucket data", () => {
            return api.createBucket("foo", {data: {a: 1}})
              .should.eventually.have.property("data")
                             .to.have.property("a").eql(1);
          });
        });

        describe("Safe option", () => {
          it("should not override existing bucket", () => {
            return api.createBucket("foo", {safe: true})
              .should.be.rejectedWith(Error, /412 Precondition Failed/);
          });
        });
      });

      describe("permissions option", () => {
        beforeEach(() => {
          return api.createBucket("foo", {
            permissions: {
              read: ["github:n1k0"]
            }
          }).then(res => result = res);
        });

        it("should create a bucket having a list of write permissions", () => {
          expect(result).to.have.property("permissions")
                        .to.have.property("read").to.eql(["github:n1k0"]);
        });
      });
    });

    describe("#deleteBucket()", () => {
      let last_modified;

      beforeEach(() => {
        return api.createBucket("foo")
          .then(({data}) => last_modified = data.last_modified);
      });

      it("should delete a bucket", () => {
        return api.deleteBucket("foo")
          .then(_ => api.listBuckets())
          .then(({data}) => data.map(bucket => bucket.id))
          .should.eventually.not.include("foo");
      });

      describe("Safe option", () => {
        it("should raise a conflict error when resource has changed", () => {
          return api.deleteBucket("foo", {
            last_modified: last_modified - 1000,
            safe: true,
          })
            .should.be.rejectedWith(Error, /412 Precondition Failed/);
        });
      });
    });

    describe("#deleteBuckets()", () => {
      before(function() {
        try {
          checkVersion(server.http_api_version, "1.4", "2.0");
        } catch(err) {
          this.skip();
        }
      });

      beforeEach(() => {
        return api.batch(batch => {
          batch.createBucket("b1");
          batch.createBucket("b2");
        });
      });

      it("should delete all buckets", () => {
        return api.deleteBuckets()
          // Note: Server tends to take a lot of time to perform this operation,
          // so we're delaying check a little.
          .then(_ => delayedPromise(50))
          .then(_ => api.listBuckets())
          .then(({data}) => data)
          .should.become([]);
      });
    });

    describe("#listPermissions", () => {
      beforeEach(() => {
        return api.batch(batch => {
          batch.createBucket("b1");
          batch.bucket("b1").createCollection("c1");
        });
      });

      it("should retrieve the list of permissions", () => {
        return api.listPermissions()
          .then(({data}) => {
            expect(data).to.have.length.of(2);
            expect(data.map(p => p.id).sort()).eql(["b1", "c1"]);
          });
      });
    });

    describe("#listBuckets", () => {
      beforeEach(() => {
        return api.batch(batch => {
          batch.createBucket("b1", {data: {size: 24}});
          batch.createBucket("b2", {data: {size: 13}});
          batch.createBucket("b3", {data: {size: 38}});
          batch.createBucket("b4", {data: {size: -4}});
        });
      });

      it("should retrieve the list of buckets", () => {
        return api.listBuckets()
          .then(({data}) => data.map(bucket => bucket.id).sort())
          .should.become(["b1", "b2", "b3", "b4"]);
      });

      it("should order buckets by field", () => {
        return api.listBuckets({sort: "-size"})
          .then(({data}) => data.map(bucket => bucket.id))
          .should.eventually.become(["b3", "b1", "b2", "b4"]);
      });

      describe("Filtering", () => {
        it("should filter buckets", () => {
          return api.listBuckets({sort: "size", filters: {min_size: 20}})
            .then(({data}) => data.map(bucket => bucket.id))
            .should.become(["b1", "b3"]);
        });

        it("should resolve with buckets last_modified value", () => {
          return api.listBuckets()
            .should.eventually.have.property("last_modified")
                              .to.be.a("string");
        });

        it("should retrieve only buckets after provided timestamp", () => {
          let timestamp;
          return api.listBuckets()
            .then(({last_modified}) => {
              timestamp = last_modified;
              return api.createBucket("b5");
            })
            .then(() => api.listBuckets({since: timestamp}))
            .should.eventually.have.property("data").to.have.length.of(1);
        });
      });

      describe("Pagination", () => {
        it("should not paginate by default", () => {
          return api.listBuckets()
            .then(({data}) => data.map(bucket => bucket.id))
            .should.become(["b4", "b3", "b2", "b1"]);
        });

        it("should paginate by chunks", () => {
          return api.listBuckets({limit: 2})
            .then(({data}) => data.map(bucket => bucket.id))
            .should.become(["b4", "b3"]);
        });

        it("should expose a hasNextPage boolean prop", () => {
          return api.listBuckets({limit: 2})
            .should.eventually.have.property("hasNextPage").eql(true);
        });

        it("should provide a next method to load next page", () => {
          return api.listBuckets({limit: 2})
            .then(res => res.next())
            .then(({data}) => data.map(bucket => bucket.id))
            .should.become(["b2", "b1"]);
        });
      });
    });

    describe("#batch", () => {
      describe("No chunked requests", () => {
        it("should allow batching operations", () => {
          return api.batch(batch => {
            batch.createBucket("custom");
            const bucket = batch.bucket("custom");
            bucket.createCollection("blog");
            const coll = bucket.collection("blog");
            coll.createRecord({title: "art1"});
            coll.createRecord({title: "art2"});
          })
            .then(_ => api.bucket("custom").collection("blog").listRecords())
            .then(({data}) => data.map(record => record.title))
            .should.become(["art2", "art1"]);
        });
      });

      describe("Chunked requests", () => {
        it("should allow batching by chunks", () => {
          return api.batch(batch => {
            batch.createBucket("custom");
            const bucket = batch.bucket("custom");
            bucket.createCollection("blog");
            const coll = bucket.collection("blog");
            for (let i=1; i<=27; i++) {
              coll.createRecord({title: "art" + i});
            }
          })
            .then(_ => api.bucket("custom").collection("blog").listRecords())
            .should.eventually.have.property("data")
                           .to.have.length.of(27);
        });
      });

      describe("aggregate option", () => {
        describe("Succesful publication", () => {
          describe("No chunking", () => {
            let results;

            beforeEach(() => {
              return api.batch(batch => {
                batch.createBucket("custom");
                const bucket = batch.bucket("custom");
                bucket.createCollection("blog");
                const coll = bucket.collection("blog");
                coll.createRecord({title: "art1"});
                coll.createRecord({title: "art2"});
              }, {aggregate: true})
                .then(_results => results = _results);
            });

            it("should return an aggregated result object", () => {
              expect(results).to.include.keys([
                "errors",
                "conflicts",
                "published",
                "skipped"
              ]);
            });

            it("should contain the list of succesful publications", () => {
              expect(results.published.map(body => body.data))
                .to.have.length.of(4);
            });
          });

          describe("Chunked response", () => {
            let results;

            beforeEach(() => {
              return api.bucket("default").collection("blog").batch(batch => {
                for (let i=1; i<=26; i++) {
                  batch.createRecord({title: "art" + i});
                }
              }, {aggregate: true})
                .then(_results => results = _results);
            });

            it("should return an aggregated result object", () => {
              expect(results).to.include.keys([
                "errors",
                "conflicts",
                "published",
                "skipped"
              ]);
            });

            it("should contain the list of succesful publications", () => {
              expect(results.published).to.have.length.of(26);
            });
          });
        });
      });
    });
  });

  describe("Backed off server", () => {
    const backoffSeconds = 10;

    before(() => {
      return server.start({KINTO_BACKOFF: backoffSeconds});
    });

    after(() => server.stop());

    beforeEach(() => server.flush());

    it("should appropriately populate the backoff property", () => {
      // Issuing a first api call to retrieve backoff information
      return api.listBuckets()
        .then(() => expect(Math.round(api.backoff / 1000)).eql(backoffSeconds));
    });
  });

  describe("Deprecated protocol version", () => {
    beforeEach(() => server.flush());

    describe("Soft EOL", () => {
      before(() => {
        const tomorrow = new Date(new Date().getTime() + 86400000).toJSON().slice(0, 10);
        return server.start({
          KINTO_EOS: tomorrow,
          KINTO_EOS_URL: "http://www.perdu.com",
          KINTO_EOS_MESSAGE: "Boom",
        });
      });

      after(() => server.stop());

      beforeEach(() => sandbox.stub(console, "warn"));

      it("should warn when the server sends a deprecation Alert header", () => {
        return api.fetchServerSettings()
          .then(_ => {
            sinon.assert.calledWithExactly(console.warn, "Boom", "http://www.perdu.com");
          });
      });
    });

    describe("Hard EOL", () => {
      before(() => {
        const lastWeek = new Date(new Date().getTime() - (7 * 86400000)).toJSON().slice(0, 10);
        return server.start({
          KINTO_EOS: lastWeek,
          KINTO_EOS_URL: "http://www.perdu.com",
          KINTO_EOS_MESSAGE: "Boom",
        });
      });

      after(() => server.stop());

      beforeEach(() => sandbox.stub(console, "warn"));

      it("should reject with a 410 Gone when hard EOL is received", () => {
        return api.fetchServerSettings()
          .should.be.rejectedWith(Error, /HTTP 410 Gone: Service deprecated/);
      });
    });
  });

  describe("Limited pagination", () => {
    before(() => {
      return server.start({KINTO_PAGINATE_BY: 1});
    });

    after(() => server.stop());

    beforeEach(() => server.flush());

    describe("Limited configured server pagination", () => {
      let collection;

      beforeEach(() => {
        collection = api.bucket("default").collection("posts");
        return collection.batch(batch => {
          batch.createRecord({n: 1});
          batch.createRecord({n: 2});
        });
      });

      it("should fetch one results page", () => {
        return collection.listRecords()
          .then(({data}) => data.map(record => record.n))
          .should.eventually.have.length.of(1);
      });

      it("should fetch all available pages", () => {
        return collection.listRecords({pages: Infinity})
          .then(({data}) => data.map(record => record.n))
          .should.eventually.have.length.of(2);
      });
    });
  });

  describe("Chainable API", () => {
    before(() => {
      return server.start();
    });

    after(() => server.stop());

    beforeEach(() => server.flush());

    describe(".bucket()", () => {
      let bucket;

      beforeEach(() => {
        bucket = api.bucket("custom");
        return api.createBucket("custom")
          .then(_ => bucket.batch(batch => {
            batch.createCollection("c1", {data: {size: 24}});
            batch.createCollection("c2", {data: {size: 13}});
            batch.createCollection("c3", {data: {size: 38}});
            batch.createCollection("c4", {data: {size: -4}});

            batch.createGroup("g1", [], {data: {size: 24}});
            batch.createGroup("g2", [], {data: {size: 13}});
            batch.createGroup("g3", [], {data: {size: 38}});
            batch.createGroup("g4", [], {data: {size: -4}});
          }));
      });

      describe(".getData()", () => {
        let result;

        beforeEach(() => {
          return bucket.getData().then(res => result = res);
        });

        it("should retrieve the bucket identifier", () => {
          expect(result).to.have.property("id").eql("custom");
        });

        it("should retrieve bucket last_modified value", () => {
          expect(result).to.have.property("last_modified").to.be.gt(1);
        });
      });

      describe(".setData()", () => {
        beforeEach(() => {
          return bucket.setPermissions({"read": ["github:jon"]});
        });

        it("should post data to the bucket", () => {
          return bucket.setData({a: 1})
            .then(({data, permissions}) => {
              expect(data.a).eql(1);
              expect(permissions.read).to.include("github:jon");
            });
        });

        it("should patch existing data for the bucket", () => {
          return bucket.setData({a: 1})
            .then(() => bucket.setData({b: 2}, {patch: true}))
            .then(({data, permissions}) => {
              expect(data.a).eql(1);
              expect(data.b).eql(2);
              expect(permissions.read).to.include("github:jon");
            });
        });

        it("should post data to the default bucket", () => {
          return api.bucket("default").setData({a: 1})
            .then(({data}) => data)
            .should.eventually.have.property("a").eql(1);
        });
      });

      describe(".permissions", () => {
        describe(".getPermissions()", () => {
          it("should retrieve bucket permissions", () => {
            return bucket.getPermissions()
              .should.eventually.have.property("write").to.have.length.of(1);
          });
        });

        describe(".setPermissions()", () => {
          beforeEach(() => {
            return bucket.setData({a: 1});
          });

          it("should set bucket permissions", () => {
            return bucket.setPermissions({read: ["github:n1k0"]})
              .then(({data, permissions}) => {
                expect(data.a).eql(1);
                expect(permissions.read).eql(["github:n1k0"]);
              });
          });

          describe("Safe option", () => {
            it("should check for concurrency", () => {
              return bucket.setPermissions({read: ["github:n1k0"]}, {
                safe: true,
                last_modified: 1,
              })
                .should.be.rejectedWith(Error, /412 Precondition Failed/);
            });
          });
        });
      });

      describe(".listHistory()", () => {
        it("should retrieve the list of history entries", () => {
          return bucket.listHistory()
            .then(({data}) => data.map(entry => entry.target.data.id))
            .should.become(["g4", "g3", "g2", "g1", "c4", "c3", "c2", "c1", "custom"]);
        });

        it("should order entries by field", () => {
          return bucket.listHistory({sort: "date"})
            .then(({data}) => data.map(entry => entry.target.data.id))
            .should.eventually.become(["custom", "c1", "c2", "c3", "c4", "g1", "g2", "g3", "g4"]);
        });

        describe("Filtering", () => {
          it("should filter entries by top-level attributes", () => {
            return bucket.listHistory({filters: {resource_name: "bucket"}})
              .then(({data}) => data.map(entry => entry.target.data.id))
              .should.become(["custom"]);
          });

          it("should filter entries by target attributes", () => {
            return bucket.listHistory({filters: {"target.data.id": "custom"}})
              .then(({data}) => data.map(entry => entry.target.data.id))
              .should.become(["custom"]);
          });

          it("should resolve with entries last_modified value", () => {
            return bucket.listHistory()
              .should.eventually.have.property("last_modified")
                                .to.be.a("string");
          });

          it("should retrieve only entries after provided timestamp", () => {
            let timestamp;
            return bucket.listHistory()
              .then(({last_modified}) => {
                timestamp = last_modified;
                return bucket.createCollection("c5");
              })
              .then(() => bucket.listHistory({since: timestamp}))
              .should.eventually.have.property("data").to.have.length.of(1);
          });
        });

        describe("Pagination", () => {
          it("should not paginate by default", () => {
            return bucket.listHistory()
              .then(({data}) => data.map(entry => entry.target.data.id))
              .should.eventually.have.length.of(9);
          });

          it("should paginate by chunks", () => {
            return bucket.listHistory({limit: 2})
              .then(({data}) => data.map(entry => entry.target.data.id))
              .should.become(["g4", "g3"]);
          });

          it("should provide a next method to load next page", () => {
            return bucket.listHistory({limit: 2})
              .then(res => res.next())
              .then(({data}) => data.map(entry => entry.target.data.id))
              .should.become(["g2", "g1"]);
          });
        });
      });

      describe(".listCollections()", () => {
        it("should retrieve the list of collections", () => {
          return bucket.listCollections()
            .then(({data}) => data.map(collection => collection.id).sort())
            .should.become(["c1", "c2", "c3", "c4"]);
        });

        it("should order collections by field", () => {
          return bucket.listCollections({sort: "-size"})
            .then(({data}) => data.map(collection => collection.id))
            .should.eventually.become(["c3", "c1", "c2", "c4"]);
        });

        describe("Filtering", () => {
          it("should filter collections", () => {
            return bucket.listCollections({sort: "size", filters: {min_size: 20}})
              .then(({data}) => data.map(collection => collection.id))
              .should.become(["c1", "c3"]);
          });

          it("should resolve with collections last_modified value", () => {
            return bucket.listCollections()
              .should.eventually.have.property("last_modified")
                                .to.be.a("string");
          });

          it("should retrieve only collections after provided timestamp", () => {
            let timestamp;
            return bucket.listCollections()
              .then(({last_modified}) => {
                timestamp = last_modified;
                return bucket.createCollection("c5");
              })
              .then(() => bucket.listCollections({since: timestamp}))
              .should.eventually.have.property("data").to.have.length.of(1);
          });
        });

        describe("Pagination", () => {
          it("should not paginate by default", () => {
            return bucket.listCollections()
              .then(({data}) => data.map(collection => collection.id))
              .should.become(["c4", "c3", "c2", "c1"]);
          });

          it("should paginate by chunks", () => {
            return bucket.listCollections({limit: 2})
              .then(({data}) => data.map(collection => collection.id))
              .should.become(["c4", "c3"]);
          });

          it("should provide a next method to load next page", () => {
            return bucket.listCollections({limit: 2})
              .then(res => res.next())
              .then(({data}) => data.map(collection => collection.id))
              .should.become(["c2", "c1"]);
          });
        });
      });

      describe(".createCollection()", () => {
        it("should create a named collection", () => {
          return bucket.createCollection("foo")
            .then(_ => bucket.listCollections())
            .then(({data}) => data.map(coll => coll.id))
            .should.eventually.include("foo");
        });

        it("should create an automatically named collection", () => {
          let generated;

          return bucket.createCollection()
            .then(res => generated = res.data.id)
            .then(_ => bucket.listCollections())
            .then(({data}) => expect(data.some(x => x.id === generated)).eql(true));
        });

        describe("Safe option", () => {
          it("should not override existing collection", () => {
            return bucket.createCollection("posts")
              .then(_ => bucket.createCollection("posts", {safe: true}))
              .should.be.rejectedWith(Error, /412 Precondition Failed/);
          });
        });

        describe("Permissions option", () => {
          let result;

          beforeEach(() => {
            return bucket.createCollection("posts", {
              permissions: {
                read: ["github:n1k0"]
              }
            }).then(res => result = res);
          });

          it("should create a collection having a list of write permissions", () => {
            expect(result).to.have.property("permissions")
                          .to.have.property("read").to.eql(["github:n1k0"]);
          });
        });

        describe("Data option", () => {
          let result;

          beforeEach(() => {
            return bucket.createCollection("posts", {
              data: {foo: "bar"}
            }).then(res => result = res);
          });

          it("should create a collection having the expected data attached", () => {
            expect(result).to.have.property("data")
                          .to.have.property("foo").eql("bar");
          });
        });
      });

      describe(".deleteCollection()", () => {
        it("should delete a collection", () => {
          return bucket.createCollection("foo")
            .then(_ => bucket.deleteCollection("foo"))
            .then(_ => bucket.listCollections())
            .then(({data}) => data.map(coll => coll.id))
            .should.eventually.not.include("foo");
        });

        describe("Safe option", () => {
          it("should check for concurrency", () => {
            return bucket.createCollection("posts")
              .then(({data}) => bucket.deleteCollection("posts", {
                safe: true,
                last_modified: data.last_modified - 1000
              }))
              .should.be.rejectedWith(Error, /412 Precondition Failed/);
          });
        });
      });

      describe(".listGroups()", () => {
        it("should retrieve the list of groups", () => {
          return bucket.listGroups()
            .then(({data}) => data.map(group => group.id).sort())
            .should.become(["g1", "g2", "g3", "g4"]);
        });

        it("should order groups by field", () => {
          return bucket.listGroups({sort: "-size"})
            .then(({data}) => data.map(group => group.id))
            .should.eventually.become(["g3", "g1", "g2", "g4"]);
        });

        describe("Filtering", () => {
          it("should filter groups", () => {
            return bucket.listGroups({sort: "size", filters: {min_size: 20}})
              .then(({data}) => data.map(group => group.id))
              .should.become(["g1", "g3"]);
          });

          it("should resolve with groups last_modified value", () => {
            return bucket.listGroups()
              .should.eventually.have.property("last_modified")
                                .to.be.a("string");
          });

          it("should retrieve only groups after provided timestamp", () => {
            let timestamp;
            return bucket.listGroups()
              .then(({last_modified}) => {
                timestamp = last_modified;
                return bucket.createGroup("g5", []);
              })
              .then(() => bucket.listGroups({since: timestamp}))
              .should.eventually.have.property("data").to.have.length.of(1);
          });
        });

        describe("Pagination", () => {
          it("should not paginate by default", () => {
            return bucket.listGroups()
              .then(({data}) => data.map(group => group.id))
              .should.become(["g4", "g3", "g2", "g1"]);
          });

          it("should paginate by chunks", () => {
            return bucket.listGroups({limit: 2})
              .then(({data}) => data.map(group => group.id))
              .should.become(["g4", "g3"]);
          });

          it("should provide a next method to load next page", () => {
            return bucket.listGroups({limit: 2})
              .then(res => res.next())
              .then(({data}) => data.map(group => group.id))
              .should.become(["g2", "g1"]);
          });
        });
      });

      describe(".createGroup()", () => {
        it("should create a named group", () => {
          return bucket.createGroup("foo")
            .then(_ => bucket.listGroups())
            .then(({data}) => data.map(group => group.id))
            .should.eventually.include("foo");
        });

        it("should create an automatically named group", () => {
          let generated;

          return bucket.createGroup()
            .then(res => generated = res.data.id)
            .then(_ => bucket.listGroups())
            .then(({data}) => expect(data.some(x => x.id === generated)).eql(true));
        });

        describe("Safe option", () => {
          it("should not override existing group", () => {
            return bucket.createGroup("admins")
              .then(_ => bucket.createGroup("admins", [], {safe: true}))
              .should.be.rejectedWith(Error, /412 Precondition Failed/);
          });
        });

        describe("Permissions option", () => {
          let result;

          beforeEach(() => {
            return bucket.createGroup("admins", ["twitter:leplatrem"], {
              permissions: {
                read: ["github:n1k0"]
              }
            }).then(res => result = res);
          });

          it("should create a collection having a list of write permissions", () => {
            expect(result).to.have.property("permissions")
                          .to.have.property("read").to.eql(["github:n1k0"]);
            expect(result.data.members).to.include("twitter:leplatrem");
          });
        });

        describe("Data option", () => {
          let result;

          beforeEach(() => {
            return bucket.createGroup("admins", ["twitter:leplatrem"], {
              data: {foo: "bar"}
            }).then(res => result = res);
          });

          it("should create a collection having the expected data attached", () => {
            expect(result).to.have.property("data")
                          .to.have.property("foo").eql("bar");
            expect(result.data.members).to.include("twitter:leplatrem");
          });
        });
      });

      describe(".getGroup()", () => {
        it("should get a group", () => {
          return bucket.createGroup("foo")
            .then(_ => bucket.getGroup("foo"))
            .then(({data, permissions}) => {
              expect(data.id).eql("foo");
              expect(data.members).eql([]);
              expect(permissions.write).to.have.length.of(1);
            });
        });
      });

      describe(".updateGroup()", () => {
        it("should update a group", () => {
          return bucket
            .createGroup("foo")
            .then(({data}) => bucket.updateGroup({...data, title: "mod"}))
            .then(_ => bucket.listGroups())
            .then(({data}) => data[0].title)
            .should.become("mod");
        });

        it("should patch a group", () => {
          return bucket.createGroup("foo", ["github:me"], {data: {title: "foo", blah: 42}})
            .then(({data}) => bucket.updateGroup({id: data.id, blah: 43},
                                                 {patch: true}))
            .then(_ => bucket.listGroups())
            .then(({data}) => {
              expect(data[0].title).eql("foo");
              expect(data[0].members).eql(["github:me"]);
              expect(data[0].blah).eql(43);
            });
        });

        describe("Safe option", () => {
          const id = "2dcd0e65-468c-4655-8015-30c8b3a1c8f8";

          it("should perform concurrency checks with last_modified", () => {
            return bucket.createGroup("foo")
              .then(({data}) => bucket.updateGroup({
                id: data.id,
                members: ["github:me"],
                title: "foo",
                last_modified: 1,
              }, {safe: true}))
              .should.be.rejectedWith(Error, /412 Precondition Failed/);
          });

          it("should create a non-existent resource when safe is true", () => {
            return bucket.updateGroup({id, members: ["all"]}, {safe: true})
              .should.eventually.have.property("data")
                             .to.have.property("members").eql(["all"]);
          });

          it("should not override existing data with no last_modified", () => {
            return bucket.createGroup("foo")
              .then(({data}) => bucket.updateGroup({
                id: data.id,
                members: [],
                title: "foo",
              }, {safe: true}))
              .should.be.rejectedWith(Error, /412 Precondition Failed/);
          });
        });
      });

      describe(".deleteGroup()", () => {
        it("should delete a group", () => {
          return bucket.createGroup("foo")
            .then(_ => bucket.deleteGroup("foo"))
            .then(_ => bucket.listGroups())
            .then(({data}) => data.map(coll => coll.id))
            .should.eventually.not.include("foo");
        });

        describe("Safe option", () => {
          it("should check for concurrency", () => {
            return bucket.createGroup("posts")
              .then(({data}) => bucket.deleteGroup("posts", {
                safe: true,
                last_modified: data.last_modified - 1000
              }))
              .should.be.rejectedWith(Error, /412 Precondition Failed/);
          });
        });
      });

      describe(".batch()", () => {
        it("should allow batching operations for current bucket", () => {
          return bucket.batch(batch => {
            batch.createCollection("comments");
            const coll = batch.collection("comments");
            coll.createRecord({content: "plop"});
            coll.createRecord({content: "yo"});
          })
            .then(_ => bucket.collection("comments").listRecords())
            .then(({data}) => data.map(comment => comment.content).sort())
            .should.become(["plop", "yo"]);
        });

        describe("Safe option", () => {
          it("should allow batching operations for current bucket", () => {
            return bucket.batch(batch => {
              batch.createCollection("comments");
              batch.createCollection("comments");
            }, {safe: true, aggregate: true})
              .should.eventually.have.property("conflicts")
              .to.have.length.of(1);
          });
        });
      });
    });

    describe(".collection()", () => {
      function runSuite(label, collPromise) {
        describe(label, () => {
          let coll;

          beforeEach(() => {
            return collPromise().then(_coll => coll = _coll);
          });

          describe(".getTotalRecords()", () => {
            it("should retrieve the initial total number of records", () => {
              return coll.getTotalRecords()
                .should.become(0);
            });

            it("should retrieve the updated total number of records", () => {
              return coll.batch(batch => {
                batch.createRecord({a: 1});
                batch.createRecord({a: 2});
              })
                .then(() => coll.getTotalRecords())
                .should.become(2);
            });
          });

          describe(".getPermissions()", () => {
            it("should retrieve permissions", () => {
              return coll.getPermissions()
                .should.eventually.have.property("write")
                .to.have.length.of(1);
            });
          });

          describe(".setPermissions()", () => {
            beforeEach(() => {
              return coll.setData({a: 1});
            });

            it("should set typed permissions", () => {
              return coll.setPermissions({read: ["github:n1k0"]})
                .then(({data, permissions}) => {
                  expect(data.a).eql(1);
                  expect(permissions.read).eql(["github:n1k0"]);
                });
            });

            describe("Safe option", () => {
              it("should perform concurrency checks", () => {
                return coll.setPermissions({read: ["github:n1k0"]}, {
                  safe: true,
                  last_modified: 1
                })
                  .should.be.rejectedWith(Error, /412 Precondition Failed/);
              });
            });
          });

          describe(".getData()", () => {
            it("should retrieve collection data", () => {
              return coll.setData({signed: true})
                .then(_ => coll.getData())
                .should.eventually.have.property("signed").eql(true);
            });
          });

          describe(".setData()", () => {
            beforeEach(() => {
              return coll.setPermissions({"read": ["github:n1k0"]});
            });

            it("should set collection data", () => {
              return coll.setData({signed: true})
                .then(({data, permissions}) => {
                  expect(data.signed).eql(true);
                  expect(permissions.read).to.include("github:n1k0");
                });
            });

            describe("Safe option", () => {
              it("should perform concurrency checks", () => {
                return coll.setData({signed: true}, {
                  safe: true,
                  last_modified: 1
                })
                  .should.be.rejectedWith(Error, /412 Precondition Failed/);
              });
            });
          });

          describe(".createRecord()", () => {
            describe("No record id provided", () => {
              it("should create a record", () => {
                return coll
                  .createRecord({title: "foo"})
                  .should.eventually.have.property("data")
                      .to.have.property("title").eql("foo");
              });

              describe("Safe option", () => {
                it("should check for existing record", () => {
                  return coll.createRecord({title: "foo"})
                    .then(({data}) => coll.createRecord({
                      id: data.id,
                      title: "foo"
                    }, {safe: true}))
                    .should.be.rejectedWith(Error, /412 Precondition Failed/);
                });
              });
            });

            describe("Record id provided", () => {
              const record = {
                id: "37f727ed-c8c4-461b-80ac-de874992165c",
                title: "foo"
              };

              it("should create a record", () => {
                return coll
                  .createRecord(record)
                  .should.eventually.have.property("data")
                      .to.have.property("title").eql("foo");
              });
            });
          });

          describe(".updateRecord()", () => {
            it("should update a record", () => {
              return coll
                .createRecord({title: "foo"})
                .then(({data}) => coll.updateRecord({...data, title: "mod"}))
                .then(_ => coll.listRecords())
                .then(({data}) => data[0].title)
                .should.become("mod");
            });

            it("should patch a record", () => {
              return coll.createRecord({title: "foo", blah: 42})
                .then(({data}) => coll.updateRecord({id: data.id, blah: 43},
                                                    {patch: true}))
                .then(_ => coll.listRecords())
                .then(({data}) => {
                  expect(data[0].title).eql("foo");
                  expect(data[0].blah).eql(43);
                });
            });

            it("should create the record if it doesn't exist yet", () => {
              const id = "2dcd0e65-468c-4655-8015-30c8b3a1c8f8";

              return coll.updateRecord({id, title: "blah"})
                .then(res => coll.getRecord(res.data.id))
                .should.eventually.have.property("data")
                               .to.have.property("title").eql("blah");
            });

            describe("Safe option", () => {
              const id = "2dcd0e65-468c-4655-8015-30c8b3a1c8f8";

              it("should perform concurrency checks with last_modified", () => {
                return coll.createRecord({title: "foo"})
                  .then(({data}) => coll.updateRecord({
                    id: data.id,
                    title: "foo",
                    last_modified: 1,
                  }, {safe: true}))
                  .should.be.rejectedWith(Error, /412 Precondition Failed/);
              });

              it("should create a non-existent resource when safe is true", () => {
                return coll.updateRecord({id, title: "foo"}, {safe: true})
                  .should.eventually.have.property("data")
                                 .to.have.property("title").eql("foo");
              });

              it("should not override existing data with no last_modified", () => {
                return coll.createRecord({title: "foo"})
                  .then(({data}) => coll.updateRecord({
                    id: data.id,
                    title: "foo",
                  }, {safe: true}))
                  .should.be.rejectedWith(Error, /412 Precondition Failed/);
              });
            });
          });

          describe(".deleteRecord()", () => {
            it("should delete a record", () => {
              return coll
                .createRecord({title: "foo"})
                .then(({data}) => coll.deleteRecord(data.id))
                .then(_ => coll.listRecords())
                .should.eventually.have.property("data").eql([]);
            });

            describe("Safe option", () => {
              it("should perform concurrency checks", () => {
                return coll.createRecord({title: "foo"})
                  .then(({data}) => coll.deleteRecord(data.id, {
                    last_modified: 1,
                    safe: true
                  }))
                  .should.be.rejectedWith(Error, /412 Precondition Failed/);
              });
            });
          });

          describe(".addAttachment()", () => {
            describe("With filename", () => {
              const input = "test";
              const dataURL = "data:text/plain;name=test.txt;base64," + btoa(input);

              let result;

              beforeEach(() => {
                return coll
                  .addAttachment(dataURL, {foo: "bar"}, {
                    permissions: {write: ["github:n1k0"]},
                  })
                  .then(res => result = res);
              });

              it("should create a record with an attachment", () => {
                expect(result)
                  .to.have.property("data")
                  .to.have.property("attachment")
                  .to.have.property("size").eql(input.length);
              });

              it("should create a record with provided record data", () => {
                expect(result)
                  .to.have.property("data")
                  .to.have.property("foo").eql("bar");
              });

              it("should create a record with provided permissions", () => {
                expect(result)
                  .to.have.property("permissions")
                  .to.have.property("write").contains("github:n1k0");
              });
            });

            describe("Without filename", () => {
              const dataURL = "data:text/plain;base64," + btoa("blah");

              it("should default filename to 'untitled' if not specified", () => {
                return coll
                  .addAttachment(dataURL)
                  .should.eventually
                  .have.property("data")
                  .have.property("attachment")
                  .have.property("filename").eql("untitled");
              });

              it("should allow to specify safe in options", () => {
                return coll
                  .addAttachment(dataURL, undefined, {safe: true})
                  .should.eventually
                  .to.have.property("data")
                  .to.have.property("attachment")
                  .to.have.property("size").eql(4);
              });

              it("should allow to specify a filename in options", () => {
                return coll
                  .addAttachment(dataURL, undefined, {filename: "MYFILE.DAT"})
                  .should.eventually
                  .have.property("data")
                  .have.property("attachment")
                  .have.property("filename").eql("MYFILE.DAT");
              });
            });
          });

          describe(".removeAttachment()", () => {
            const input = "test";
            const dataURL = "data:text/plain;name=test.txt;base64," + btoa(input);

            let recordId;

            beforeEach(() => {
              return coll.addAttachment(dataURL)
                .then(res => recordId = res.data.id);
            });

            it("should remove an attachment from a record", () => {
              return coll.removeAttachment(recordId)
                .then(() => coll.getRecord(recordId))
                .should.eventually.have.property("data")
                               .to.have.property("attachment").eql(null);
            });
          });

          describe(".getRecord()", () => {
            it("should retrieve a record by its id", () => {
              return coll.createRecord({title: "blah"})
                .then(res => coll.getRecord(res.data.id))
                .should.eventually.have.property("data")
                               .to.have.property("title").eql("blah");
            });
          });

          describe(".listRecords()", () => {
            it("should list records", () => {
              return coll
                .createRecord({title: "foo"})
                .then(_ => coll.listRecords())
                .then(({data}) => data.map(record => record.title))
                .should.become(["foo"]);
            });

            it("should expose the total number of records", () => {
              return  coll.createRecord({a: 1})
                .then(() => coll.createRecord({a: 2}))
                .then(() => coll.listRecords())
                .should.eventually.have.property("totalRecords").eql(2);
            });

            it("should order records by field", () => {
              return Promise.all(["art3", "art1", "art2"].map((title) => {
                return coll.createRecord({title});
              }))
                .then(_ => coll.listRecords({sort: "title"}))
                .then(({data}) => data.map(record => record.title))
                .should.eventually.become(["art1", "art2", "art3"]);
            });

            describe("Filtering", () => {
              beforeEach(() => {
                return coll.batch(batch => {
                  batch.createRecord({name: "paul", age: 28});
                  batch.createRecord({name: "jess", age: 54});
                  batch.createRecord({name: "john", age: 33});
                  batch.createRecord({name: "rené", age: 24});
                });
              });

              it("should filter records", () => {
                return coll.listRecords({sort: "age", filters: {min_age: 30}})
                  .then(({data}) => data.map(record => record.name))
                  .should.become(["john", "jess"]);
              });

              it("should properly escape unicode filters", () => {
                return coll.listRecords({filters: {name: "rené"}})
                  .then(({data}) => data.map(record => record.name))
                  .should.become(["rené"]);
              });

              it("should resolve with collection last_modified value", () => {
                return coll.listRecords()
                  .should.eventually.have.property("last_modified")
                                    .to.be.a("string");
              });
            });

            describe("Changes", () => {
              let ts1, ts2;

              beforeEach(() => {
                return coll.listRecords()
                  .then(({last_modified}) => ts1 = last_modified)
                  .then(_ => coll.createRecord({n: 1}))
                  .then(_ => coll.listRecords())
                  .then(({last_modified}) => ts2 = last_modified)
                  .then(_ => coll.createRecord({n: 2}));
              });

              it("should retrieve all records modified since provided timestamp", () => {
                return coll.listRecords({since: ts1})
                  .should.eventually.have.property("data").to.have.length.of(2);
              });

              it("should only list changes made after the provided timestamp", () => {
                return coll.listRecords({since: ts2})
                  .should.eventually.have.property("data").to.have.length.of(1);
              });
            });

            describe("Pagination", () => {
              beforeEach(() => {
                return coll.batch(batch => {
                  for (let i = 1; i <= 3; i++) {
                    batch.createRecord({n: i});
                  }
                });
              });

              it("should not paginate by default", () => {
                return coll.listRecords()
                  .then(({data}) => data.map(record => record.n))
                  .should.become([3, 2, 1]);
              });

              it("should paginate by chunks", () => {
                return coll.listRecords({limit: 2})
                  .then(({data}) => data.map(record => record.n))
                  .should.become([3, 2]);
              });

              it("should provide a next method to load next page", () => {
                return coll.listRecords({limit: 2})
                  .then(res => res.next())
                  .then(({data}) => data.map(record => record.n))
                  .should.become([1]);
              });

              it("should resolve with an empty array on exhausted pagination", () => {
                return coll.listRecords({limit: 2}) // 1st page of 2 records
                  .then(res => res.next())          // 2nd page of 1 record
                  .then(res => res.next())          // No next page
                  .should.be.rejectedWith(Error, /Pagination exhausted./);
              });

              it("should retrieve all pages", () => {
                // Note: Server has no limit by default, so here we get all the
                // records.
                return coll.listRecords()
                  .then(({data}) => data.map(record => record.n))
                  .should.become([3, 2, 1]);
              });

              it("should retrieve specified number of pages", () => {
                return coll.listRecords({limit: 1, pages: 2})
                  .then(({data}) => data.map(record => record.n))
                  .should.become([3, 2]);
              });

              it("should allow fetching next page after last page if any", () => {
                return coll.listRecords({limit: 1, pages: 1}) // 1 record
                  .then(({data, next}) => next())             // 2 records
                  .then(({data}) => data.map(record => record.n))
                  .should.become([3, 2]);
              });

              it("should should retrieve all existing pages", () => {
                return coll.listRecords({limit: 1, pages: Infinity})
                  .then(({data}) => data.map(record => record.n))
                  .should.become([3, 2, 1]);
              });
            });
          });

          describe(".batch()", () => {
            it("should allow batching operations in the current collection", () => {
              return coll.batch(batch => {
                batch.createRecord({title: "a"});
                batch.createRecord({title: "b"});
              })
                .then(_ => coll.listRecords({sort: "title"}))
                .then(({data}) => data.map(record => record.title))
                .should.become(["a", "b"]);
            });
          });
        });
      }

      runSuite("default bucket", () => {
        return api.bucket("default")
          .createCollection("plop")
          .then(_ => api.bucket("default").collection("plop"));
      });

      runSuite("custom bucket", () => {
        return api.createBucket("custom")
        .then(_ => api.bucket("custom").createCollection("plop"))
        .then(_ => api.bucket("custom").collection("plop"));
      });
    });
  });
});
