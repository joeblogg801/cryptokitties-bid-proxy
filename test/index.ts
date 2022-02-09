import { expect, use } from "chai";
import chaiAsPromised from "chai-as-promised";
import { ethers, network } from "hardhat";
import { BidProxy, IKittyCore, ISaleClockAuction } from "../typechain";
import { AccessList } from "@ethersproject/transactions";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { isAddress, parseEther } from "ethers/lib/utils";

use(chaiAsPromised);

const PIN_BLOCK = 14129100;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const KITTY_CORE_ADDRESS = "0x06012c8cf97BEaD5deAe237070F9587f8E7A266d";
const SALE_AUCTION_ADDRESS = "0xb1690C08E213a35Ed9bAb7B318DE14420FB57d8C";

interface TestCase {
  kittyUnderTest: number;
  cloneableWalletProxy: string;
  cloneableWallet: string;
}

const testCases: TestCase[] = [
  {
    kittyUnderTest: 1960011,
    cloneableWalletProxy: "0xDdf0723cdc1546f9Dd3e2AFA4DDf694842743173",
    cloneableWallet: "0x37932f3ECA864632156CcbA7E2814b51A374caEc",
  },
  {
    kittyUnderTest: 1832000,
    cloneableWalletProxy: "0xdc7a31BEDd6609c5cbbA978B5592CD69C4A42e56",
    cloneableWallet: "0x989A2ad9aCaa8C4e50B2fC6B650d6e1809b9195b",
  },
];

describe("BidProxy", function () {
  beforeEach(async function () {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.MAINNET_URL,
            blockNumber: PIN_BLOCK,
          },
        },
      ],
    });
  });

  let bidProxy: BidProxy;
  let bidProxyAddress: string;
  let firstAccount: SignerWithAddress;
  let secondAccount: SignerWithAddress;
  let thirdAccount: SignerWithAddress;
  beforeEach(async function () {
    [firstAccount, secondAccount, thirdAccount] = await ethers.getSigners();
    const BidProxy = await ethers.getContractFactory(
      "BidProxy",
      firstAccount // deployer
    );
    bidProxy = (await BidProxy.deploy(
      KITTY_CORE_ADDRESS,
      SALE_AUCTION_ADDRESS
    )) as any as BidProxy;
    await bidProxy.deployed();
    bidProxyAddress = (bidProxy as any).address; // not sure why typescript cannot find address
    expect(isAddress(bidProxyAddress));
  });

  let kittyCore: IKittyCore;
  let saleAuction: ISaleClockAuction;
  beforeEach(async function () {
    kittyCore = (await ethers.getContractAt(
      "IKittyCore",
      KITTY_CORE_ADDRESS
    )) as any as IKittyCore;
    saleAuction = (await ethers.getContractAt(
      "ISaleClockAuction",
      SALE_AUCTION_ADDRESS
    )) as any as ISaleClockAuction;
  });

  describe("Access control", function () {
    it("should set owner to the account that deploys contract", async function () {
      expect(await bidProxy.owner()).to.equal(firstAccount.address);
      expect(await bidProxy.paused()).to.equal(false);
    });
    it("can only be transfered by owner", async function () {
      const scenarios: {
        from: SignerWithAddress;
        to: SignerWithAddress | string;
        canTransfer: boolean;
      }[] = [
        { from: secondAccount, to: ZERO_ADDRESS, canTransfer: false },
        { from: secondAccount, to: firstAccount, canTransfer: false },
        { from: secondAccount, to: secondAccount, canTransfer: false },
        { from: secondAccount, to: thirdAccount, canTransfer: false },

        { from: firstAccount, to: ZERO_ADDRESS, canTransfer: false },
        { from: firstAccount, to: firstAccount, canTransfer: true },
        { from: firstAccount, to: secondAccount, canTransfer: true },
        { from: firstAccount, to: firstAccount, canTransfer: false },
        { from: firstAccount, to: thirdAccount, canTransfer: false },

        { from: secondAccount, to: ZERO_ADDRESS, canTransfer: false },
        { from: secondAccount, to: secondAccount, canTransfer: true },
        { from: secondAccount, to: firstAccount, canTransfer: true },
        { from: secondAccount, to: secondAccount, canTransfer: false },

        { from: firstAccount, to: firstAccount, canTransfer: true },
      ];
      for (const { from, to, canTransfer } of scenarios) {
        bidProxy = bidProxy.connect(from);
        const toAddress = typeof to === "string" ? to : to.address;
        if (canTransfer) {
          await bidProxy.transferOwnership(toAddress);
          expect(await bidProxy.owner()).to.equal(toAddress);
        } else {
          const currentOwner = await bidProxy.owner();
          await expect(bidProxy.transferOwnership(toAddress)).be.rejectedWith(
            Error
          );
          expect(await bidProxy.owner()).to.equal(currentOwner);
        }
      }
    });
    it("can only be paused/unpaused by owner", async function () {
      async function runScenarios(
        scenarios: {
          caller: SignerWithAddress;
          operation: "pause" | "unpause";
          canDoIt: boolean;
        }[]
      ) {
        for (const { caller, operation, canDoIt } of scenarios) {
          bidProxy = bidProxy.connect(caller);
          const currentPaused = await bidProxy.paused();
          if (canDoIt) {
            await bidProxy[operation]();
            expect(await bidProxy.paused()).to.equal(!currentPaused);
          } else {
            await expect(bidProxy[operation]()).be.rejectedWith(Error);
            expect(await bidProxy.paused()).to.equal(currentPaused);
          }
        }
      }

      await runScenarios([
        { caller: secondAccount, operation: "pause", canDoIt: false },
        { caller: secondAccount, operation: "unpause", canDoIt: false },

        { caller: firstAccount, operation: "unpause", canDoIt: false },
        { caller: firstAccount, operation: "pause", canDoIt: true },
        { caller: firstAccount, operation: "unpause", canDoIt: true },
        { caller: firstAccount, operation: "pause", canDoIt: true },
      ]);

      // should still be able to change owner even when paused
      expect(await bidProxy.paused()).to.equal(true);
      expect(await bidProxy.owner()).to.equal(firstAccount.address);
      await bidProxy.transferOwnership(secondAccount.address);
      expect(await bidProxy.owner()).to.equal(secondAccount.address);

      // second account should be able to unpause now
      await runScenarios([
        { caller: secondAccount, operation: "unpause", canDoIt: true },
      ]);
    });
  });

  describe("Fallback", function () {
    it("should not fail if called without any data and value (noop)", async function () {
      await firstAccount.sendTransaction({
        to: bidProxyAddress,
      });
    });
    it("should fail if called without any data but with a value (unless called from the sale auction)", async function () {
      await expect(
        firstAccount.sendTransaction({
          to: bidProxyAddress,
          value: 1,
        })
      ).to.be.rejectedWith(Error);
    });
    it("should fail if called with an unknown selector", async function () {
      await expect(
        firstAccount.sendTransaction({
          to: bidProxyAddress,
          data: "0x00000001",
        })
      ).to.be.rejectedWith(Error);
    });
    it("should fail if called with an unknown selector and value", async function () {
      await expect(
        firstAccount.sendTransaction({
          to: bidProxyAddress,
          data: "0x00000001",
          value: 1,
        })
      ).to.be.rejectedWith(Error);
    });
  });

  describe("Rescue", function () {
    const kittyToRescue = testCases[0].kittyUnderTest;
    beforeEach(async function () {
      // buy kitty to rescue and deliberately put it into contract
      expect(await bidProxy.owner()).to.equal(firstAccount.address);
      saleAuction = saleAuction.connect(firstAccount);
      const price = await saleAuction.getCurrentPrice(kittyToRescue);
      await saleAuction.bid(kittyToRescue, {
        value: price,
        accessList: [
          { address: testCases[0].cloneableWallet, storageKeys: [] },
        ],
      });
      expect(await kittyCore.ownerOf(kittyToRescue)).to.equal(
        firstAccount.address
      );
      // now transfer it to bid proxy contract
      await kittyCore.transfer(bidProxyAddress, kittyToRescue);
      expect(await kittyCore.ownerOf(kittyToRescue)).to.equal(bidProxyAddress);
    });
    it("owner should be able to rescue kitty", async function () {
      await bidProxy.rescueLostKitty(kittyToRescue, secondAccount.address);
      expect(await kittyCore.ownerOf(kittyToRescue)).to.equal(
        secondAccount.address
      );
    });
    it("owner should be able to rescue kitty via call", async function () {
      await bidProxy.call(
        KITTY_CORE_ADDRESS,
        0,
        kittyCore.interface.encodeFunctionData("transfer", [
          secondAccount.address,
          kittyToRescue,
        ])
      );
      expect(await kittyCore.ownerOf(kittyToRescue)).to.equal(
        secondAccount.address
      );
    });
    it("owner should be able to rescue ETH via call", async function () {
      const amount = parseEther("10");
      // it should not be possible to simply send ETH into contract
      await expect(
        firstAccount.sendTransaction({
          to: bidProxyAddress,
          value: amount,
        })
      ).to.be.rejectedWith(Error);
      // therefore selfdestruct some ETH into contract
      expect(await ethers.provider.getBalance(bidProxyAddress)).to.equal(0);
      await firstAccount.sendTransaction({
        // selfdestruct(payable(bidProxy))
        data: `0x73${bidProxyAddress.slice(2).toLowerCase()}ff`,
        value: amount,
      });
      expect(await ethers.provider.getBalance(bidProxyAddress)).to.equal(
        amount
      );
      const balanceBefore = await secondAccount.getBalance();
      // rescue funds
      await bidProxy.call(secondAccount.address, amount, "0x");
      expect(await ethers.provider.getBalance(bidProxyAddress)).to.equal(0);
      const balanceAfter = await secondAccount.getBalance();
      expect(balanceAfter.sub(balanceBefore)).to.equal(amount);
    });
  });

  describe("Bid", function () {
    for (const testCase of testCases) {
      defineTests(testCase, true);
      defineTests(testCase, false);
    }

    function defineTests(testCase: TestCase, useExactAmount: boolean) {
      async function checkPreconditions() {
        expect(await kittyCore.ownerOf(testCase.kittyUnderTest)).to.equal(
          SALE_AUCTION_ADDRESS
        );
        const auction = await saleAuction.getAuction(testCase.kittyUnderTest);
        expect(auction.seller).to.equal(testCase.cloneableWalletProxy);
        const sellerCode = await ethers.provider.getCode(
          testCase.cloneableWalletProxy
        );
        // clonable wallet
        expect(sellerCode).to.equal(
          // "0x363d3d373d3d3d363d7337932f3eca864632156ccba7e2814b51a374caec5af43d82803e903d91602b57fd5bf3",
          `0x363d3d373d3d3d363d73${testCase.cloneableWallet
            .slice(2)
            .toLowerCase()}5af43d82803e903d91602b57fd5bf3`
        );
      }

      async function testDirectBuy({
        useAccessList,
      }: {
        useAccessList: boolean;
      }) {
        await checkPreconditions();

        // all calls are made under second account
        kittyCore = kittyCore.connect(secondAccount);
        saleAuction = saleAuction.connect(secondAccount);
        bidProxy = bidProxy.connect(secondAccount);

        expect(await kittyCore.ownerOf(testCase.kittyUnderTest)).to.equal(
          SALE_AUCTION_ADDRESS
        );

        const price = await saleAuction.getCurrentPrice(
          testCase.kittyUnderTest
        );
        const pricePlusWei = price.add(1);

        const balanceBefore = await secondAccount.getBalance();

        const accessList: AccessList = useAccessList
          ? [{ address: testCase.cloneableWallet, storageKeys: [] }]
          : [];

        const txPromise = saleAuction.bid(testCase.kittyUnderTest, {
          value: useExactAmount ? price : pricePlusWei,
          accessList,
        });

        if (useAccessList) {
          const tx = await txPromise;
          const receipt = await tx.wait();
          const gasPayment = tx.gasPrice?.mul(receipt.gasUsed);
          console.log("gas used in direct buy", receipt.gasUsed.toNumber());

          // check who the owner is
          expect(await kittyCore.ownerOf(testCase.kittyUnderTest)).to.equal(
            secondAccount.address
          );
          const balanceAfter = await secondAccount.getBalance();
          // check that caller received their change back (1 wei) and only price + gasPayment was charged
          expect(balanceBefore.sub(price).sub(gasPayment!)).equal(balanceAfter);
        } else {
          await expect(txPromise).to.be.rejectedWith(
            Error,
            "Transaction reverted without a reason string"
          );
        }
      }

      it(`Should be able to buy a kitty ${testCase.kittyUnderTest} ${
        useExactAmount ? " with exact amount" : ""
      } if access list is used`, async function () {
        await testDirectBuy({ useAccessList: true });
      });

      it(`Should not be able to buy a kitty ${testCase.kittyUnderTest} ${
        useExactAmount ? " with exact amount" : ""
      } without using access list`, async function () {
        await testDirectBuy({ useAccessList: false });
      });

      it(`Should be able to buy a kitty ${
        testCase.kittyUnderTest
      } via proxy contract ${
        useExactAmount ? " with exact amount" : ""
      } without using access list`, async function () {
        await checkPreconditions();

        // all calls are made under second account which is not a owner
        kittyCore = kittyCore.connect(secondAccount);
        saleAuction = saleAuction.connect(secondAccount);
        bidProxy = bidProxy.connect(secondAccount);
        expect(await bidProxy.owner()).to.equal(firstAccount.address);
        expect(firstAccount.address).to.not.equal(secondAccount.address);
        expect(secondAccount.address).to.not.equal(SALE_AUCTION_ADDRESS);

        expect(await kittyCore.ownerOf(testCase.kittyUnderTest)).to.equal(
          SALE_AUCTION_ADDRESS
        );

        const price = await saleAuction.getCurrentPrice(
          testCase.kittyUnderTest
        );
        const pricePlusWei = price.add(1);
        const balanceBefore = await secondAccount.getBalance();
        const tx = await bidProxy.bid(testCase.kittyUnderTest, {
          value: useExactAmount ? price : pricePlusWei,
          // NO access list here
        });
        const receipt = await tx.wait();
        const gasPayment = tx.gasPrice?.mul(receipt.gasUsed).toBigInt();
        console.log("gas used in proxy buy", receipt.gasUsed.toNumber());

        // check who the owner is
        expect(await kittyCore.ownerOf(testCase.kittyUnderTest)).to.equal(
          secondAccount.address
        );
        const balanceAfter = await secondAccount.getBalance();
        // check that caller received their change back (1 wei) and only price + gasPayment was charged
        expect(balanceBefore.sub(price).sub(gasPayment!)).equal(balanceAfter);
      });

      for (const { wallets, success } of [
        { wallets: [testCase.cloneableWallet], success: true },
        // eslint-disable-next-line prettier/prettier
        { wallets: [testCase.cloneableWallet, ZERO_ADDRESS], success: true },
        // eslint-disable-next-line prettier/prettier
        { wallets: [testCase.cloneableWallet, ZERO_ADDRESS, testCase.cloneableWalletProxy], success: true },
        // eslint-disable-next-line prettier/prettier
        { wallets: [ZERO_ADDRESS, testCase.cloneableWalletProxy, testCase.cloneableWallet], success: true },
        { wallets: [], success: false },
        { wallets: [ZERO_ADDRESS], success: false },
        // eslint-disable-next-line prettier/prettier
        { wallets: [ZERO_ADDRESS, testCase.cloneableWalletProxy], success: false },
      ]) {
        it(`Should ${success ? "be" : "not be"} able to buy a kitty ${
          testCase.kittyUnderTest
        } via proxy contract ${
          useExactAmount ? " with exact amount" : ""
        } without using access list by warming up just [${wallets.join(
          ", "
        )}]`, async function () {
          await checkPreconditions();

          // all calls are made under second account which is not a owner
          kittyCore = kittyCore.connect(secondAccount);
          saleAuction = saleAuction.connect(secondAccount);
          bidProxy = bidProxy.connect(secondAccount);
          expect(await bidProxy.owner()).to.equal(firstAccount.address);
          expect(firstAccount.address).to.not.equal(secondAccount.address);
          expect(secondAccount.address).to.not.equal(SALE_AUCTION_ADDRESS);

          expect(await kittyCore.ownerOf(testCase.kittyUnderTest)).to.equal(
            SALE_AUCTION_ADDRESS
          );

          const price = await saleAuction.getCurrentPrice(
            testCase.kittyUnderTest
          );
          const pricePlusWei = price.add(1);
          const balanceBefore = await secondAccount.getBalance();
          const txPromise = bidProxy.bidWithSpecificWarmups(
            testCase.kittyUnderTest,
            wallets,
            {
              value: useExactAmount ? price : pricePlusWei,
              // NO access list here
            }
          );
          if (success) {
            const tx = await txPromise;
            const receipt = await tx.wait();
            const gasPayment = tx.gasPrice?.mul(receipt.gasUsed).toBigInt();
            console.log(
              "gas used in proxy buy with a specific warmup",
              receipt.gasUsed.toNumber()
            );

            // check who the owner is
            expect(await kittyCore.ownerOf(testCase.kittyUnderTest)).to.equal(
              secondAccount.address
            );
            const balanceAfter = await secondAccount.getBalance();
            // check that caller received their change back (1 wei) and only price + gasPayment was charged
            expect(balanceBefore.sub(price).sub(gasPayment!)).equal(
              balanceAfter
            );
          } else {
            await expect(txPromise).to.be.rejectedWith(
              Error,
              "Transaction reverted without a reason string"
            );
          }
        });
      }
    }
  });
});
